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
    private PluginCall pendingBatchCall;

    @PluginMethod
    public void requestWritePermissions(PluginCall call) {
        JSArray urisArr = call.getArray("uris");
        if (urisArr == null || urisArr.length() == 0) {
            call.resolve();
            return;
        }
        java.util.List<Uri> uris = new java.util.ArrayList<>();
        for (int i = 0; i < urisArr.length(); i++) {
            try {
                String s = urisArr.getString(i);
                if (s != null) uris.add(Uri.parse(s));
            } catch (Exception ignored) {
            }
        }
        if (uris.isEmpty()) {
            call.resolve();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                PendingIntent pi = MediaStore.createWriteRequest(
                    getContext().getContentResolver(), uris
                );
                pendingBatchCall = call;
                pi.send(0,
                    new PendingIntent.OnFinished() {
                        @Override
                        public void onSendFinished(PendingIntent pi, Intent intent,
                                                   int resultCode, String resultData,
                                                   Bundle resultExtras) {
                            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                                pendingBatchCall.resolve();
                            }, 500);
                        }
                    }, new Handler(Looper.getMainLooper()));
            } catch (PendingIntent.CanceledException ex) {
                call.reject("Permission request canceled");
            } catch (Exception ex) {
                call.reject("Failed to request write permissions: " + ex.getMessage());
            }
        } else {
            call.resolve();
        }
    }

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

            String name = queryDisplayName(uri, resolver);
            String mimeType = resolver.getType(uri);
            long size = querySize(uri, resolver);
            String mediaStoreUri = findMediaStoreUri(uri, name, (int) size);

            String thumbBase64 = generateThumbnailBase64(uri, resolver);

            JSObject img = new JSObject();
            img.put("id", uri.toString());
            img.put("contentUri", uri.toString());
            img.put("replaceUri", mediaStoreUri != null ? mediaStoreUri : uri.toString());
            img.put("name", name);
            img.put("size", size);
            img.put("mimeType", mimeType != null ? mimeType : "image/jpeg");
            img.put("thumbnailBase64", thumbBase64);
            return img;
        } catch (Exception e) {
            return null;
        }
    }

    private long querySize(Uri uri, ContentResolver resolver) {
        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (sizeIdx >= 0) return cursor.getLong(sizeIdx);
            }
        } catch (Exception ignored) {
        }
        return 0;
    }

    private String generateThumbnailBase64(Uri uri, ContentResolver resolver) {
        try {
            android.graphics.BitmapFactory.Options opts = new android.graphics.BitmapFactory.Options();
            opts.inJustDecodeBounds = true;
            InputStream is = resolver.openInputStream(uri);
            android.graphics.BitmapFactory.decodeStream(is, null, opts);
            is.close();

            int sampleSize = 1;
            while (opts.outWidth / sampleSize > 200 || opts.outHeight / sampleSize > 200) {
                sampleSize *= 2;
            }

            opts.inJustDecodeBounds = false;
            opts.inSampleSize = sampleSize;
            is = resolver.openInputStream(uri);
            android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeStream(is, null, opts);
            is.close();
            if (bmp == null) return "";

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, baos);
            bmp.recycle();
            return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    @PluginMethod
    public void readImage(PluginCall call) {
        String contentUriStr = call.getString("contentUri");
        if (contentUriStr == null) {
            call.reject("Missing contentUri");
            return;
        }
        try {
            Uri uri = Uri.parse(contentUriStr);
            InputStream is = getContext().getContentResolver().openInputStream(uri);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int len;
            while ((len = is.read(buffer)) != -1) {
                baos.write(buffer, 0, len);
            }
            is.close();
            String base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
            JSObject ret = new JSObject();
            ret.put("base64", base64);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Read failed: " + e.getMessage());
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
        String replaceUriStr = call.getString("replaceUri");
        String base64Str = call.getString("base64");
        String mimeType = call.getString("mimeType");

        if (replaceUriStr == null || base64Str == null) {
            call.reject("Missing required parameters");
            return;
        }

        Uri uri = Uri.parse(replaceUriStr);
        byte[] data = Base64.decode(base64Str, Base64.NO_WRAP);

        try {
            writeData(uri, data);
            call.resolve();
        } catch (RecoverableSecurityException e) {
            pendingReplaceCall = call;
            pendingReplaceUri = uri;
            pendingReplaceData = data;
            try {
                PendingIntent pi;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    pi = MediaStore.createWriteRequest(
                        getContext().getContentResolver(),
                        java.util.Collections.singletonList(uri)
                    );
                } else {
                    pi = e.getUserAction().getActionIntent();
                }
                pi.send(0,
                    new PendingIntent.OnFinished() {
                        @Override
                        public void onSendFinished(PendingIntent pi, Intent intent,
                                                   int resultCode, String resultData,
                                                   Bundle resultExtras) {
                            retryWrite(0);
                        }
                    }, new Handler(Looper.getMainLooper()));
            } catch (PendingIntent.CanceledException ex) {
                call.reject("Permission request canceled");
            }
        } catch (SecurityException e) {
            pendingReplaceCall = call;
            pendingReplaceUri = uri;
            pendingReplaceData = data;
            retryWrite(0);
        } catch (Exception e) {
            call.reject("Replace failed: " + e.getMessage());
        }
    }

    private void writeData(Uri uri, byte[] data) throws Exception {
        OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt");
        if (os == null) {
            throw new Exception("Cannot open output stream");
        }
        os.write(data);
        os.flush();
        os.close();
    }

    private void retryWrite(final int attempt) {
        if (attempt >= 5) {
            pendingReplaceCall.reject("授权后仍无法写入。请到系统设置 → 应用管理 → 图片压缩 → 权限，开启存储权限后重试");
            return;
        }
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    writeData(pendingReplaceUri, pendingReplaceData);
                    pendingReplaceCall.resolve();
                } catch (RecoverableSecurityException e) {
                    try {
                        PendingIntent pi;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                            pi = MediaStore.createWriteRequest(
                                getContext().getContentResolver(),
                                java.util.Collections.singletonList(pendingReplaceUri)
                            );
                        } else {
                            pi = e.getUserAction().getActionIntent();
                        }
                        pi.send(0,
                            new PendingIntent.OnFinished() {
                                @Override
                                public void onSendFinished(PendingIntent pi, Intent intent,
                                                           int resultCode, String resultData,
                                                           Bundle resultExtras) {
                                    retryWrite(attempt + 1);
                                }
                            }, new Handler(Looper.getMainLooper()));
                    } catch (PendingIntent.CanceledException ex) {
                        pendingReplaceCall.reject("Permission request canceled");
                    }
                } catch (Exception ex) {
                    retryWrite(attempt + 1);
                }
            }
        }, 600);
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