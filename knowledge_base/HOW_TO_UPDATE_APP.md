# Beginner's Guide: How to Update MediLog NG and Deploy Updates to Hospitals

This guide explains step-by-step how to save your changes in Git, publish a new version to GitHub, and have the hospital's Host PC (and all connected ward PCs) update automatically.

---

## 🌟 The Big Picture (How It Works)

```
Your Computer                GitHub               Hospital Host PC           Hospital Ward PCs
─────────────                ──────               ────────────────           ─────────────────
1. Make changes    ───► 3. Git Push (Code)
2. Bump version    ───► 4. GitHub Release ───►  5. Host PC automatically ──► 6. Doctors & Nurses
   & Build Exe             (Upload .exe)           downloads & restarts         simply reload!
                                                   (Serves new version)         (No install needed!)
```

When you update the app:
1. You save and upload your updated code to **GitHub**.
2. You upload the new build (`MediLogHost-Setup-X.X.X.exe` and `host.yml`) to a **GitHub Release**.
3. The hospital's **Host PC** automatically downloads the new version in the background and prompts the operator to restart.
4. When the Host PC restarts, it serves the new version. **All other PCs in the hospital immediately get the update without installing anything!**

---

## 🛠️ Step 0: One-Time Setup (Check if Git is Installed)

Open **PowerShell** or **Command Prompt** and type:
```powershell
git --version
```

- **If it shows `git version 2.x.x`**: You are ready! Proceed to Step 1.
- **If it says `'git' is not recognized`**:
  1. Download Git from: **[https://git-scm.com/download/win](https://git-scm.com/download/win)**
  2. Run the installer and click **Next** through the defaults.
  3. Close and reopen your terminal.

> 💡 **Beginner Tip:** If you prefer clicking buttons instead of typing commands in a terminal, you can also install **[GitHub Desktop](https://desktop.github.com/)**. It lets you click "Commit" and "Push" with your mouse.

---

## 📋 The Complete 5-Step Routine to Release an Update

Whenever you add a feature, fix a bug, or make changes, follow these 5 steps in order:

---

### Step 1: Test Your Changes Locally

Before sharing an update with the hospital, make sure your changes work and nothing is broken:

1. Double-click **`run-dev.bat`** in the project folder.
2. Select **`[1]`** to test the Host App, or **`[5]`** to run automated tests.
3. Verify that your new feature or fix works as expected.
4. Close the test window when done.

---

### Step 2: Bump the Version Number

Every new release must have a higher version number (e.g. `1.0.0` → `1.0.1`) so the updater knows a new version exists.

You can do this in one click:
1. Double-click **`bump-version.bat`** in the project root.
2. The script shows your current version and asks for the update type:
   - Press **`1`** for **Patch** (Bug fixes & minor tweaks: `1.0.0` → `1.0.1`)
   - Press **`2`** for **Minor** (New features & reports: `1.0.0` → `1.1.0`)
   - Press **`3`** for **Major** (Major restructuring: `1.0.0` → `2.0.0`)
3. The script automatically updates `package.json` and `src/buildInfo.js` with the new version and timestamp!

*(Alternative: You can also run `node scripts/bump-version.mjs patch` from the terminal).*

---

### Step 3: Build the New Host Installer

Double-click **`build-host.bat`** in the project root (or run `npm run dist:host`).

When it finishes, look inside the **`release\`** folder in your project:
You will see:
1. `MediLogHost-Setup-1.0.1.exe` (The new Windows installer)
2. `host.yml` (The auto-update information file containing file hashes)

> ⚠️ **Important:** Keep both `MediLogHost-Setup-1.0.1.exe` and `host.yml` ready—you will upload both to GitHub in Step 5.

---

### Step 4: Save & Push Your Code to Git

Now save your source code changes to GitHub:

#### Using Command Line:
```powershell
# 1. Check which files changed
git status

# 2. Add all changed files to staging
git add .

# 3. Save your changes with a short message describing what you did
git commit -m "Add new pharmacy stock report and bump to v1.0.1"

# 4. Push your code to GitHub
git push origin main
```

#### Using GitHub Desktop (Visual):
1. Open GitHub Desktop.
2. You will see all your changed files listed on the left.
3. In the bottom-left corner, type a Summary (e.g. `Update to v1.0.1`).
4. Click the blue **"Commit to main"** button.
5. In the top bar, click **"Push origin"**.

Your code is now safely backed up on GitHub!

---

### Step 5: Publish the Update on GitHub (Triggers Auto-Update)

This is the step that allows the hospital's Host PC to download the update automatically.

1. Open your web browser and go to your repository's Releases page:
   ```
   https://github.com/imradexglobal/medlogng/releases
   ```
2. Click the **"Draft a new release"** (or **"Create a new release"**) button.
3. Fill in the fields:
   - **Choose a tag**: Type `v1.0.1` (replace with your new version number) and click **Create new tag: v1.0.1 on publish**.
   - **Release title**: `MediLog NG v1.0.1`
   - **Description**: Briefly list what's new or fixed (e.g., `- Fixed receipt printing bug`, `- Improved pharmacy stock loading`).
4. **Attach the update binaries**:
   - Drag and drop **`release\MediLogHost-Setup-1.0.1.exe`** into the upload box.
   - Drag and drop **`release\host.yml`** into the upload box.
5. Click **"Publish release"**.

---

## 🏥 What Happens at the Hospital?

Once you click "Publish release", you do not have to do anything else!

1. **Host PC**:
   - The MediLog Host PC in the hospital periodically checks GitHub for updates.
   - It sees the new `v1.0.1` release and downloads it quietly in the background.
   - When the download completes, a prompt appears on screen and in the Windows System Tray:
     > **"Update ready: v1.0.1. Restart now to apply."**
   - The hospital IT admin or operator clicks **Restart now** (or right-clicks the green tray icon and clicks `⚡ Restart & Install Update`).
   - The app restarts within ~5 seconds with the new version running.

2. **Connected Hospital PCs (Wards, Clinics, Doctors, Nurses)**:
   - **No software installation is required.**
   - Connected PCs access `http://<HOST_IP>:8787` in Chrome or Edge.
   - Because the Host PC is now serving the new `v1.0.1` files, any connected PC that reloads the page or opens a new tab immediately runs the updated version!
   - If a doctor or nurse left a tab open, the built-in Service Worker detects the new version and shows a gentle notification: *"New update available. Click to reload."*

---

## ⚡ Quick Copy-Paste Cheatsheet

| Task | Command |
|---|---|
| **Test Host App Locally** | Double-click `run-dev.bat` (Option 1) |
| **Bump Version (Interactive)**| Double-click `bump-version.bat` |
| **Bump Version (Terminal)**| `node scripts/bump-version.mjs patch` |
| **Build Host .exe** | Double-click `build-host.bat` |
| **Stage Changes in Git** | `git add .` |
| **Commit Changes** | `git commit -m "Description of changes"` |
| **Push Code to GitHub** | `git push origin main` |

---

## ❓ Frequently Asked Questions (FAQ)

### 1. What if a hospital has no internet connection?
The app runs 100% offline on the hospital's local Wi-Fi router. If internet is down, the hospital continues operating normally. When the internet connection returns, the Host PC checks GitHub and queues any pending cloud syncs.

### 2. Can I manually update the Host PC with a USB flash drive?
Yes! If the hospital's Host PC is never connected to the internet:
1. Run `build-host.bat` on your computer.
2. Copy `release\MediLogHost-Setup-1.0.1.exe` to a USB flash drive.
3. Plug the flash drive into the hospital's Host PC and run the `.exe`.
4. It will install over the previous version and keep all hospital data and configuration intact.

### 3. Will updating wipe out patient data or settings?
**No.** All hospital databases, configuration files, and Firebase credentials are stored safely in Windows AppData (`%APPDATA%\MediLog NG Host`), completely separate from the program files. Updates only update the code, never your data.
