# AAF eVote Station

**AAF eVote Station** lets pupils vote on a Windows PC or an Android tablet or phone when there is no internet. Each device keeps the votes it collects. When the device gets internet again, it sends them to the school's AAF eVote website.

| | |
|---|---|
| **Android** | Android 14, 15, 16 and 17 (minimum API 34, built against API 36) |
| **Windows** | Windows 10 and 11 (64-bit) |
| **Server** | AAF eVote website with the `api/station` upgrade |

## How it works

1. **Set up (needs internet, about 1 minute).**
   - Open the app.
   - Type the website address, for example `https://dade.aaf-evote.org`.
   - Sign in with a teacher account.
   - The app downloads the election for that teacher's school: the posts, the candidates with their photos, the pupils on the list, and who has already voted.
2. **Voting (no internet needed).**
   - A pupil types the username and passcode from their slip.
   - They choose one person for each post. A post can be skipped.
   - They check their choices and tap **Cast my vote**.
   - The vote is saved on the device straight away.
3. **Sending votes.** Every 20 seconds the app checks whether it can reach the website. When it can, it sends the waiting votes. The orange **"N to send"** badge in the top bar shows how many votes are still on the device.
4. **One vote per pupil.**
   - The website keeps the first vote that reaches it for each pupil. Any later vote from another device, or from the website itself, is not counted.
   - The teacher area lists those later votes under **"Votes the server did not count"**.
   - On a single device, a pupil who has already voted cannot vote again.

## Teacher area

Tap **Teacher** in the top bar. It asks for the password of the teacher who set up the device, and it also works offline. The area locks itself after 5 minutes of inactivity.

- **Overview:** turnout overall and by class, votes waiting to send, a **Send now** button, and the votes the server did not count.
- **Pupils:** search for a pupil, show their passcode, print one slip, and see whether they have voted.
- **Print slips:** print login slips for a class, or only for pupils who have not voted yet. Windows uses the normal print window. Android uses Android printing, which also offers **Save as PDF**.
- **This device:**
  - **Download the latest election:** use this after changing pupils, candidates, passcodes or times on the website.
  - **Save a backup of votes:** saves a file of the votes not yet sent.
  - **Sign in again:** use this if the website signed the device out.
  - **Sign out this device:** only possible once every vote has been sent.

## Safety

- Each pupil's passcode is checked on the device against a protected hash (PBKDF2), not against the passcode itself.
- The plain passcodes, which are needed to reprint slips, are stored encrypted (AES-256). The key comes from the teacher's password, so slips cannot be printed without it.
- Once the website accepts a vote, the device deletes that pupil's choices. Only "voted / sent" is kept.
- The website checks every vote before counting it:
  - the pupil is on the election list and belongs to the device's school;
  - every choice is a real candidate for that post;
  - the vote was cast within the voting time (5 minutes of clock slack allowed).
- Each device signs in with its own token. Signing the device out on the website, or changing the teacher's password, stops the device from sending votes. Its votes stay on the device until a teacher signs in again.
- **Limit of offline voting:** a person with full control of a device, its storage and developer tools could try to guess passcodes or add votes on that device. Keep stations supervised, as you would a ballot box.

## Building (automatic on GitHub)

Every push to `main` runs **Actions → Build apps**, which produces two files:

- `android-apk`: `AAF-eVote-Station-<version>.apk`
- `windows-installer`: `AAF-eVote-Station-Setup-<version>.exe`

To publish them on a GitHub Release, push a tag:

```
git tag v1.0.1 && git push --tags
```

To release a new version:

1. Change `version` in `package.json`.
2. Push. The Android version code increases automatically with each build, so new APKs install over old ones and keep the saved votes.

### Signing

- **Android.** Release builds are signed with a key kept in the repository's secrets, never in the code:
  - `ANDROID_KEYSTORE_BASE64`: the keystore file, base64-encoded.
  - `ANDROID_KEYSTORE_PASSWORD`: the keystore password.
  - `ANDROID_KEY_ALIAS`: the key alias (`station`).

  Add them under **Settings → Secrets and variables → Actions**. Every build is then signed with the same key, so new versions install over old ones and keep the saved votes.

  Without the secrets, the workflow builds a debug-signed APK. It works, but a later build will not install over it without first uninstalling the app, and uninstalling deletes any unsent votes.

  To make a key yourself:

  ```
  keytool -genkeypair -keystore station.keystore -storetype PKCS12 -alias station -keyalg RSA -keysize 2048 -validity 12000
  base64 -w0 station.keystore
  ```

  The second command prints the text to paste into `ANDROID_KEYSTORE_BASE64`. Keep the keystore file and its password somewhere safe.
- **Windows.** The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. A code-signing certificate removes this warning.

### Installing

- **Android:** copy the `.apk` to the device and open it. Allow "Install unknown apps" for the Files app or browser when asked.
- **Windows:** run the `Setup` file and choose where to install. It creates desktop and Start-menu shortcuts.

## Developing

```
npm ci
npm start                 # Windows app (Electron) on your computer
npx cap sync android      # copy www/ into the Android project
npx cap open android      # open it in Android Studio
```

The app itself is plain HTML, CSS and JavaScript in `www/`, shared by both platforms.

| Path | What it is |
|---|---|
| `www/` | The station app |
| `electron/` | Windows wrapper. Serves `www/` from `app://station`. |
| `android/` | Android project (Capacitor 8). Includes `StationPrintPlugin.java` for printing and backups. |
| `assets/`, `build/` | Icons and splash screens |
| `test/` | Playwright end-to-end tests against a local AAF eVote server |

## Server API

The website must have `StationController`, `App\Support\Stations` and the `station` routes in `routes/api.php`. The two tables, `station_devices` and `station_votes`, are created automatically on first use.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/station/login` | Teacher signs in → device token |
| GET | `/api/station/package?school_id=` | Election, posts, candidates (photos), pupils (passcode hashes), who has voted |
| GET | `/api/station/status` | Server clock, who has voted, whether the package changed |
| POST | `/api/station/sync` | Up to 500 votes. Returns `accepted`, `duplicate` or `rejected` for each vote. |
| POST | `/api/station/logout` | Forget this device |
