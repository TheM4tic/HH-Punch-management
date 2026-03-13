import { initializeApp } from "firebase/app";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
} from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
// Note: Firebase Storage is NOT used — photos are stored on Cloudinary (free tier).
// Firebase stays on the free Spark plan. No credit card required.

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const missingVars = Object.entries(firebaseConfig)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missingVars.length > 0) {
  console.error("Missing Firebase environment variables:", missingVars.join(", "));
}

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Firebase 10+ persistent cache (replaces deprecated enableIndexedDbPersistence)
// Works across multiple tabs and survives browser restarts — critical for field use
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

// Persist auth across browser restarts
setPersistence(auth, browserLocalPersistence).catch(console.error);

export const isFirebaseConfigured = missingVars.length === 0;
