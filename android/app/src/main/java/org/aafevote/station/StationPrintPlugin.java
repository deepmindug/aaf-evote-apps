package org.aafevote.station;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Small native helpers for the station app:
 *  print()    – opens Android's print screen for the current page (login slips), incl. "Save as PDF".
 *  saveText() – saves a backup file of unsent votes into Downloads/AAF eVote.
 */
@CapacitorPlugin(name = "StationPrint")
public class StationPrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        final String name = call.getString("name", "AAF eVote");
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                WebView wv = getBridge().getWebView();
                PrintDocumentAdapter adapter = wv.createPrintDocumentAdapter(name);
                PrintAttributes attrs = new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .build();
                pm.print(name, adapter, attrs);
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not open printing: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void saveText(PluginCall call) {
        String name = call.getString("name", "evote-backup.json");
        String text = call.getString("text", "");
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/AAF eVote");
            Uri uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("Could not create the file.");
                return;
            }
            try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                if (os == null) {
                    call.reject("Could not write the file.");
                    return;
                }
                os.write(text.getBytes(StandardCharsets.UTF_8));
            }
            JSObject result = new JSObject();
            result.put("path", "Downloads/AAF eVote/" + name);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage());
        }
    }
}
