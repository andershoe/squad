// =====================================================================
// Firebase configuration
// =====================================================================
// 1. Create a project at https://console.firebase.google.com/
// 2. Enable Realtime Database (Build → Realtime Database → Create database)
// 3. Project settings → General → "Your apps" → add a Web app
// 4. Copy the values into the object below.
//
// Note: these values are NOT secret. Security comes from the rules in
// database.rules.json, not from hiding these.
// =====================================================================

window.FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  databaseURL: "https://REPLACE_ME-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME"
};
