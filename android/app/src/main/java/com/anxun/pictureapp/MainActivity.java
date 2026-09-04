package com.anxun.pictureapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PicturePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
