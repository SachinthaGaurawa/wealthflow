import Foundation
import Capacitor
import ContactsUI

/// WealthFlowContactPicker.pick(): opens iOS's own contact chooser and answers with the ONE phone number the person touched.
///
/// Least privilege, on purpose. CNContactPickerViewController runs out of process: the app receives only what the person chose, and iOS does not ask for
/// Contacts access for it, so there is no NSContactsUsageDescription and no CNContactStore anywhere in this app. The address book is never read, listed
/// or uploaded.
///
/// Answers (the web side is wealthflow-people.js: pickContactResult):
///   { cancelled: true }                               the person backed out
///   { cancelled: false, name: "...", number: "..." }  one chosen number (the name may be empty)
/// Rejections carry a code: UNAVAILABLE (no view to present on), BUSY (a chooser is already open).
@objc(WealthFlowContactPickerPlugin)
public class WealthFlowContactPickerPlugin: CAPPlugin, CAPBridgedPlugin, CNContactPickerDelegate {
    public let identifier = "WealthFlowContactPickerPlugin"
    public let jsName = "WealthFlowContactPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCallId: String?

    @objc func pick(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.pendingCallId != nil {
                call.reject("A contact chooser is already open.", "BUSY")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("No screen to show the contact chooser on.", "UNAVAILABLE")
                return
            }
            self.bridge?.saveCall(call)
            self.pendingCallId = call.callbackId

            let picker = CNContactPickerViewController()
            picker.delegate = self
            // only phone numbers are shown and only a phone number can be chosen
            picker.displayedPropertyKeys = [CNContactPhoneNumbersKey]
            picker.predicateForSelectionOfProperty = NSPredicate(format: "key == %@", CNContactPhoneNumbersKey)
            presenter.present(picker, animated: true)
        }
    }

    public func contactPicker(_ picker: CNContactPickerViewController, didSelect contactProperty: CNContactProperty) {
        guard contactProperty.key == CNContactPhoneNumbersKey, let phone = contactProperty.value as? CNPhoneNumber else {
            finish(["cancelled": true])
            return
        }
        // reading a name property that was not fetched raises an exception in Contacts, so ask first
        let contact = contactProperty.contact
        let nameKeys = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName)]
        let name = contact.areKeysAvailable(nameKeys) ? (CNContactFormatter.string(from: contact, style: .fullName) ?? "") : ""
        finish(["cancelled": false, "name": name, "number": phone.stringValue])
    }

    public func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        // always settle the promise: the page holds a one-at-a-time lock until it does
        finish(["cancelled": true])
    }

    private func finish(_ result: PluginCallResultData) {
        guard let id = pendingCallId, let call = bridge?.savedCall(withID: id) else {
            pendingCallId = nil
            return
        }
        pendingCallId = nil
        call.resolve(result)
        bridge?.releaseCall(call)
    }
}
