# QuickBinSync

Pro IO-এর Watch Bin functionality-র একটা ফ্রি, ওপেন-সোর্স CEP extension। After Effects এবং Premiere Pro দুটোতেই কাজ করে। সিস্টেমের যেকোনো ফোল্ডারকে প্রজেক্টের bin-এর সাথে link করে রাখো — এক ক্লিকে নতুন media files import হয়ে যাবে, duplicate skip হবে।

**ভার্সন:** 1.0.0
**Author:** Raisul Sohan ([raisulsohan.com](https://raisulsohan.com))

---

## ফিচার

- AE + PPro দুটোতেই dockable panel — same extension
- যেকোনো ফোল্ডারকে প্রজেক্টের bin-এর সাথে link
- Nested bin path support (`Footage/Audio` → nested folder/bin তৈরি হবে)
- Subfolder include (recursive flat scan)
- Already-imported file tracking — duplicate import হয় না
- Per-project bin list — প্রজেক্ট switch করলে আলাদা list
- Per-project last-folder memory — folder picker আগের জায়গায় খোলে
- Custom panel-internal folder browser — OS dialog dependency নেই
- Hidden/system folder filter — clean browsing experience
- Sync All / Sync individual / Reset history / Unlink

---

## ইনস্টল

### Step 1 — PlayerDebugMode চালু করো

প্রথমবার যেকোনো unsigned CEP extension চালাতে এটা লাগবে।

**Windows (cmd):**
```
reg add "HKCU\Software\Adobe\CSXS.9"  /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

**macOS (Terminal):**
```
defaults write com.adobe.CSXS.9  PlayerDebugMode 1
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

### Step 2 — পুরো `QuickBinSync` ফোল্ডার copy করো

**Windows:**
```
%APPDATA%\Adobe\CEP\extensions\QuickBinSync\
```

**macOS:**
```
~/Library/Application Support/Adobe/CEP/extensions/QuickBinSync/
```

### Step 3 — Restart + Open

AE বা Premiere Pro restart → **Window > Extensions > QuickBinSync**

---

## ব্যবহার

1. একটা saved project খোলো (.aep / .prproj)। Unsaved project-এ এটা কাজ করবে না।
2. **+ Add Watch Bin** ক্লিক করো।
3. **Browse** দিয়ে disk-এ একটা ফোল্ডার select করো — panel-এর ভেতরেই folder browser খুলবে (OS dialog না)।
4. Bin name (project panel-এ যেভাবে দেখাবে) ও Bin path (nested চাইলে `Footage/Audio` এর মতো) দাও।
5. Subfolder include করতে চাইলে checkbox রাখো।
6. **Save**।
7. পরে **Sync** চাপলে ওই ফোল্ডারের নতুন media files (ভিডিও, অডিও, ইমেজ) project-এ import হবে।

---

## কোথায় ডেটা save হয়

প্রতিটা প্রজেক্টের জন্য আলাদা JSON file:

- **Windows:** `%APPDATA%\QuickBinSync\proj_<hash>.json`
- **macOS:** `~/Library/Application Support/QuickBinSync/proj_<hash>.json`

Hash তোমার project file path থেকে generate হয়। AE আর PPro একই storage share করে — মানে একই project file path হলে দুটো অ্যাপে একই bin list দেখাবে।

---

## ফোল্ডার structure

```
QuickBinSync/
├── CSXS/
│   └── manifest.xml
├── client/
│   ├── index.html
│   ├── main.js
│   └── style.css
├── host/
│   └── host.jsx
├── lib/
│   └── CSInterface.js
└── README.md
```

---

## পরিচিত সীমাবদ্ধতা

- **Image sequence auto-detection নেই** — প্রতিটা frame আলাদা item হিসেবে import হবে।
- **Subfolder structure preserve হয় না** — recursive flat scan করে এক bin-এ ঢোকায়।
- **Auto-sync নেই** — manually Sync চাপতে হয়।
- **Unsaved project সাপোর্ট নেই** — project save করতে হবে।
- **Synced list path-based** — file rename হলে আবার import হবে।

---

## ভবিষ্যৎ feature

- Image sequence auto-detection
- Subfolder structure preserve (nested bin তৈরি)
- File extension filter UI
- Auto-sync (file watcher)
- Open folder in Explorer/Finder button
- Export Presets (পুরো নতুন phase)

---

## সমস্যা হলে

- **Panel লোড হচ্ছে না** → PlayerDebugMode সব CSXS version-এ enable আছে কিনা চেক করো; AE/PPro restart করো; CEP cache clear করো (`%LOCALAPPDATA%\Temp\cep_cache`)
- **"Save your project first"** → project untitled, একবার save করো (Ctrl+S)
- **PPro-তে import fail** → bin name special character থাকলে এড়াও (`:` `*` `?` `"` `<` `>` `|`)

---

Made with care by **Raisul Sohan** — [raisulsohan.com](https://raisulsohan.com)
