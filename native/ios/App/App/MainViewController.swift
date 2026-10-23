import UIKit
import Capacitor

/// The app's own plugins are registered here, once the bridge exists.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(WealthFlowContactPickerPlugin())
    }
}
