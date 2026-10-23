package lk.wealthflow.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * WealthFlowContactPicker.pick(): opens Android's own contact chooser and answers with the ONE phone number the person touched.
 *
 * Least privilege, on purpose. The intent below lists phone numbers (not whole contacts). The system chooser runs in the Contacts app; the app that asked
 * gets read access to the single row that was chosen, for this result only, so NO contacts permission is requested or declared (READ_CONTACTS and
 * WRITE_CONTACTS are removed from the merged manifest, see AndroidManifest.xml). The address book is never read, listed or uploaded.
 *
 * Answers (the web side is wealthflow-people.js: pickContactResult):
 *   { cancelled: true }                               the person backed out
 *   { cancelled: false, name: "...", number: "..." }  one chosen number (the name may be empty)
 * Rejections carry a code: UNAVAILABLE (no contacts app), BUSY (a chooser is already open), FAILED.
 */
@CapacitorPlugin(name = "WealthFlowContactPicker")
public class WealthFlowContactPickerPlugin extends Plugin {

    private boolean open = false;

    @PluginMethod
    public void pick(PluginCall call) {
        if (open) { call.reject("A contact chooser is already open.", "BUSY"); return; }
        Intent intent = new Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI);
        try {
            open = true;
            startActivityForResult(call, intent, "pickResult");
        } catch (ActivityNotFoundException e) {
            open = false;
            call.reject("No contacts app is available.", "UNAVAILABLE");
        } catch (RuntimeException e) {
            open = false;
            call.reject("The contact chooser could not be opened.", "FAILED");
        }
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        open = false;
        if (call == null) return;
        Intent data = result == null ? null : result.getData();
        Uri uri = data == null ? null : data.getData();
        JSObject out = new JSObject();
        if (result == null || result.getResultCode() != Activity.RESULT_OK || uri == null) {
            // backing out, or a chooser that returned nothing, is a cancel: the promise always settles, so the page's one-at-a-time lock is released
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }
        String[] columns = { ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER };
        try (Cursor cursor = getContext().getContentResolver().query(uri, columns, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                String number = cursor.getString(1);
                out.put("cancelled", false);
                out.put("name", name == null ? "" : name);
                out.put("number", number == null ? "" : number);
                call.resolve(out);
                return;
            }
        } catch (RuntimeException e) {
            call.reject("The chosen contact could not be read.", "FAILED");
            return;
        }
        out.put("cancelled", true);
        call.resolve(out);
    }
}
