const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/storage');
require('firebase/compat/firestore');

const firebaseConfig = {
    apiKey: "AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4",
    authDomain: "wealthflow-6dffb.firebaseapp.com",
    projectId: "wealthflow-6dffb",
    storageBucket: "wealthflow-6dffb.firebasestorage.app",
    messagingSenderId: "1020193373377",
    appId: "1:1020193373377:web:52ae0662d35b02037f6840",
    measurementId: "G-FKEKQGG8MZ"
};

firebase.initializeApp(firebaseConfig);

async function testAuth() {
    try {
        const userCred = await firebase.auth().signInAnonymously();
        console.log("Signed in anonymously:", userCred.user.uid);
        
        // try to write a test doc to firestore
        const docRef = firebase.firestore().collection('shared_statements').doc();
        await docRef.set({ test: 'hello', createdAt: new Date() });
        console.log("Firestore write OK");

        // try to upload a tiny blob to storage
        const storageRef = firebase.storage().ref();
        const fileRef = storageRef.child('statements/test.txt');
        await fileRef.putString("hello world");
        const url = await fileRef.getDownloadURL();
        console.log("Storage upload OK, URL:", url);

    } catch (e) {
        console.error("Error:", e.message);
    }
    process.exit(0);
}

testAuth();
