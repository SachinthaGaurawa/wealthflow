package lk.wealthflow.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // the app's own plugins are registered before the bridge starts
        registerPlugin(WealthFlowContactPickerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
