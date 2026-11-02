package com.basaltnotes.app;

import android.content.Context;
import android.content.pm.PackageManager;

final class BuildConfigInfo {
    private BuildConfigInfo() {}

    static String versionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }
}
