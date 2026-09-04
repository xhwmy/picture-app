package com.anxun.pictureapp;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.RecoverableSecurityException;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.Manifest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "Picture", permissions = {
    @Permission(strings = { Manifest.permission.READ_MEDIA_IMAGES }, alias = "readImages"),
    @Permission(strings = {
        Manifest.permission.READ_EXTERNAL_STORAGE,
        Manifest.permission.WRITE_EXTERNAL_STORAGE
    }, alias = "storage")
})
public class PicturePlugin extends Plugin {

    private PluginCall pendingReplaceCall;
    private Uri pendingReplaceUri;
    private byte[] pendingReplaceData;

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAlias("readImages", call, "permissionCallback");
        } else {
            requestPermissionForAlias("storage", call, "permissionCallback");
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void pickImages(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "pickImagesResult");
    }

    @ActivityCallback
    private void pickImagesResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("User cancelled");
            return;
        }

        Intent data = result.getData();
        if (data == null) {
            call.reject("No data returned");
            return;
        }

        JSArray images = new JSArray();
        ContentResolver resolver = getContext().getContentResolver();

        if (data.getClipData() != null) {
            int count = data.getClipData().getItemCount();
            for (int i = 0; i < count; i++) {
                Uri uri = data.getClipData().getItemAt(i).getUri();
                JSObject img = readImageFromUri(uri, resolver);
                if (img != null) images.put(img);
            }
        } else if (data.getData() != null) {
            Uri uri = data.getData();
            JSObject img = readImageFromUri(uri, resolver);
            if (img != null) images.put(img);
        }

        JSObject ret = new JSObject();
        ret.put("images", images);
        call.resolve(ret);
    }

    private JSObject readImageFromUri(Uri uri, ContentResolver resolver) {
        try {
            try {
                resolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (SecurityException ignored) {
            }

            InputStream is = resolver.openInputStream(uri);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int len;
            while ((len = is.read(buffer)) != -1) {
                baos.write(buffer, 0, len);
            }
            is.close();

            byte[] data = baos.toByteArray();
            String base64 = Base64.encodeToString(data, Base64.NO_WRAP);
            String name = queryDisplayName(uri, resolver);
            String mimeType = resolver.getType(uri);
            String mediaStoreUri = findMediaStoreUri(uri, name, data.length);

            JSObject img = new JSObject();
            img.put("id", uri.toString());
            img.put("contentUri", mediaStoreUri != null ? mediaStoreUri : uri.toString());
            img.put("name", name);
            img.put("size", data.length);
            img.put("mimeType", mimeType != null ? mimeType : "image/jpeg");
            img.put("base64", base64);
            return img;
        } catch (Exception e) {
            return null;
        }
    }

    private String queryDisplayName(Uri uri, ContentResolver resolver) {
        String name = "image";
        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIdx >= 0) {
                    String n = cursor.getString(nameIdx);
                    if (n != null) name = n;
                }
            }
        }
        return name;
    }

    private String findMediaStoreUri(Uri safUri, String displayName, int size) {
        try {
            String decoded = Uri.decode(safUri.toString());
            int idx = decoded.lastIndexOf("image:");
            if (idx >= 0) {
                String idStr = decoded.substring(idx + 6);
                int slash = idStr.indexOf('/');
                if (slash >= 0) idStr = idStr.substring(0, slash);
                long id = Long.parseLong(idStr);
                Uri mediaUri = ContentUris.withAppendedId(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                );
                return mediaUri.toString();
            }
        } catch (Exception ignored) {
        }

        try {
            String[] projection = {
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.SIZE
            };
            String selection = MediaStore.Images.Media.DISPLAY_NAME + " = ? AND "
                + MediaStore.Images.Media.SIZE + " = ?";
            String[] args = { displayName, String.valueOf(size) };
            try (Cursor cursor = getContext().getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection, selection, args, null
            )) {
                if (cursor != null && cursor.moveToFirst()) {
                    long id = cursor.getLong(
                        cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
                    );
                    Uri uri = ContentUris.withAppendedId(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                    );
                    return uri.toString();
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    @PluginMethod
    public void replaceImage(PluginCall call) {
        String contentUriStr = call.getString("contentUri");
        String base64Str = call.getString("base64");
        String mimeType = call.getString("mimeType");

        if (contentUriStr == null || base64Str == null) {
            call.reject("Missing required parameters");
            return;
        }

        try {
            Uri uri = Uri.parse(contentUriStr);
            byte[] data = Base64.decode(base64Str, Base64.NO_WRAP);

            OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt");
            if (os == null) {
                call.reject("Cannot open output stream");
                return;
            }
            os.write(data);
            os.flush();
            os.close();
            call.resolve();
        } catch (RecoverableSecurityException e) {
            pendingReplaceCall = call;
            pendingReplaceUri = Uri.parse(contentUriStr);
            pendingReplaceData = Base64.decode(base64Str, Base64.NO_WRAP);
            try {
                e.getUserAction().getActionIntent().send(0,
                    new PendingIntent.OnFinished() {
                        @Override
                        public void onSendFinished(PendingIntent pi, Intent intent,
                                                   int resultCode, String resultData,
                                                   Bundle resultExtras) {
                            if (resultCode == Activity.RESULT_OK) {
                                try {
                                    OutputStream os2 = getContext().getContentResolver()
                                        .openOutputStream(pendingReplaceUri, "wt");
                                    if (os2 == null) {
                                        pendingReplaceCall.reject("Cannot open output stream after permission");
                                        return;
                                    }
                                    os2.write(pendingReplaceData);
                                    os2.flush();
                                    os2.close();
                                    pendingReplaceCall.resolve();
                                } catch (Exception ex) {
                                    pendingReplaceCall.reject("Replace failed after permission: " + ex.getMessage());
                                }
                            } else {
                                pendingReplaceCall.reject("Permission denied");
                            }
                        }
                    }, new Handler(Looper.getMainLooper()));
            } catch (PendingIntent.CanceledException ex) {
                call.reject("Permission request canceled");
            }
        } catch (Exception e) {
            call.reject("Replace failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        String base64Str = call.getString("base64");
        String mimeType = call.getString("mimeType");
        String displayName = call.getString("displayName");

        if (base64Str == null || mimeType == null || displayName == null) {
            call.reject("Missing required parameters");
            return;
        }

        try {
            byte[] data = Base64.decode(base64Str, Base64.NO_WRAP);

            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, displayName);
            values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/PictureCompress");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
            }

            Uri uri = getContext().getContentResolver().insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values
            );
            if (uri == null) {
                call.reject("Failed to create new image entry");
                return;
            }

            OutputStream os = getContext().getContentResolver().openOutputStream(uri);
            if (os == null) {
                call.reject("Cannot open output stream for new image");
                return;
            }
            os.write(data);
            os.flush();
            os.close();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues updateValues = new ContentValues();
                updateValues.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, updateValues, null, null);
            }

            call.resolve();
        } catch (Exception e) {
            call.reject("Save failed: " + e.getMessage());
        }
    }
}