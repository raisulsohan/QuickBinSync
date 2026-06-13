// ============================================================
// QuickBinSync — frontend logic (main.js)
// Made by Raisul Sohan
// ============================================================

(function () {
    "use strict";

    // ------- Node modules (CEP --enable-nodejs) -------
    var fs        = require("fs");
    var path      = require("path");
    var os        = require("os");
    var execSync  = require("child_process").execSync;

    // ------- CSInterface bridge -------
    var cs = new CSInterface();

    // ------- Constants & Extension Groups -------
    var POLL_INTERVAL_MS = 2000;
    var AUTO_SYNC_INTERVAL_MS = 5000;
    
    var EXT_GROUPS = {
        video: [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mpg", ".mpeg", ".mxf"],
        audio: [".mp3", ".wav", ".aac", ".flac", ".m4a", ".ogg", ".aif", ".aiff"],
        image: [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".exr", ".dpx", ".tga", ".bmp", ".psd", ".ai", ".gif", ".webp", ".heic", ".raw", ".arw", ".cr2", ".nef"]
    };
    
    var DEFAULT_MEDIA_EXTS = EXT_GROUPS.video.concat(EXT_GROUPS.audio, EXT_GROUPS.image);

    // Windows system folders to hide from folder browser
    var WIN_HIDDEN_FOLDERS = {
        "$recycle.bin": true,
        "system volume information": true,
        "$winreagent": true,
        "$getcurrent": true,
        "$sysreset": true,
        "config.msi": true,
        "recovery": true,
        "msocache": true,
        "perflogs": true,
        "programdata": false,
        "windows.old": true,
        "boot": true,
        "$avg": true,
        "documents and settings": true,
        "intel": false,
        "amd": false,
        "nvidia": false
    };

    // ------- State -------
    var state = {
        projectId: null,
        projectPath: null,
        projectHost: null,
        bins: [],
        lastPickerPath: "",
        autoSync: false,           // persisted
        polling: false,
        saveTimer: null,
        // Auto-sync runtime (not persisted)
        autoSyncTimer: null,
        autoSyncBusy: false,
        manualSyncBusy: false
    };

    // ------- Folder browser state -------
    var fb = {
        currentPath: "",
        selectedPath: "",
        callback: null,
        drives: []
    };

    // ------- Element refs -------
    var el = {
        hostBadge:    document.getElementById("hostBadge"),
        projName:     document.getElementById("projName"),
        projStatus:   document.getElementById("projStatus"),
        addBinBtn:    document.getElementById("addBinBtn"),
        syncAllBtn:   document.getElementById("syncAllBtn"),
        binList:      document.getElementById("binList"),
        emptyHint:    document.getElementById("emptyHint"),
        status:       document.getElementById("status"),
        // auto-sync controls
        autoSyncToggle: document.getElementById("autoSyncToggle"),
        autoSyncDot:    document.getElementById("autoSyncDot"),
        autoSyncInfo:   document.getElementById("autoSyncInfo"),
        // bin modal
        modal:        document.getElementById("modalOverlay"),
        modalTitle:   document.getElementById("modalTitle"),
        folderInput:  document.getElementById("folderInput"),
        browseBtn:    document.getElementById("browseBtn"),
        binNameInput: document.getElementById("binNameInput"),
        binPathInput: document.getElementById("binPathInput"),
        recursiveInput: document.getElementById("recursiveInput"),
        modalCancelBtn: document.getElementById("modalCancelBtn"),
        modalSaveBtn:   document.getElementById("modalSaveBtn"),
        // folder browser
        fbOverlay:   document.getElementById("fbOverlay"),
        fbPathbar:   document.getElementById("fbPathbar"),
        fbSidebar:   document.getElementById("fbSidebar"),
        fbList:      document.getElementById("fbList"),
        fbSelected:  document.getElementById("fbSelected"),
        fbUpBtn:     document.getElementById("fbUpBtn"),
        fbHomeBtn:   document.getElementById("fbHomeBtn"),
        fbRefreshBtn:document.getElementById("fbRefreshBtn"),
        fbCancelBtn: document.getElementById("fbCancelBtn"),
        fbSelectBtn: document.getElementById("fbSelectBtn")
    };

    // ============================================================
    // Storage
    // ============================================================

    function getStorageDir() {
        var base;
        if (process.platform === "win32") {
            base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        } else if (process.platform === "darwin") {
            base = path.join(os.homedir(), "Library", "Application Support");
        } else {
            base = path.join(os.homedir(), ".config");
        }
        var dir = path.join(base, "AdobeQuickBinSync");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }
    var STORAGE_DIR = getStorageDir();

    function hashPath(p) {
        var h = 0;
        for (var i = 0; i < p.length; i++) {
            h = ((h << 5) - h) + p.charCodeAt(i);
            h = h & h;
        }
        return "proj_" + Math.abs(h).toString();
    }

    function dataFileFor(projPath) {
        return path.join(STORAGE_DIR, hashPath(projPath) + ".json");
    }

    function loadProjectData(projPath) {
        var fallback = { bins: [], lastPickerPath: "", autoSync: false };
        var f = dataFileFor(projPath);
        if (!fs.existsSync(f)) return fallback;
        try {
            var d = JSON.parse(fs.readFileSync(f, "utf8"));
            return {
                bins: d.bins || [],
                lastPickerPath: d.lastPickerPath || "",
                autoSync: !!d.autoSync
            };
        } catch (e) {
            return fallback;
        }
    }

    function saveProjectData() {
        if (!state.projectPath) return false;
        try {
            var f = dataFileFor(state.projectPath);
            var data = {
                bins: state.bins,
                lastPickerPath: state.lastPickerPath || "",
                autoSync: !!state.autoSync,
                savedAt: new Date().toISOString()
            };
            fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================================
    // Drive enumeration (Windows)
    // ============================================================

    function listWindowsDrives() {
        var drives = [];
        try {
            var out = execSync('wmic logicaldisk get caption,volumename /format:list', { windowsHide: true }).toString();
            var lines = out.split(/\r?\n/);
            var current = {};
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) {
                    if (current.Caption) drives.push(current);
                    current = {};
                    continue;
                }
                var idx = line.indexOf("=");
                if (idx > 0) {
                    var key = line.substring(0, idx);
                    var val = line.substring(idx + 1);
                    current[key] = val;
                }
            }
            if (current.Caption) drives.push(current);
        } catch (e) {
            var letters = ["C:", "D:", "E:", "F:", "G:", "H:"];
            for (var k = 0; k < letters.length; k++) {
                try {
                    if (fs.existsSync(letters[k] + "\\")) {
                        drives.push({ Caption: letters[k], VolumeName: "" });
                    }
                } catch (eL) {}
            }
        }
        return drives;
    }

    // ============================================================
    // Hidden folder check
    // ============================================================

    function isHiddenFolder(name) {
        if (name.charAt(0) === ".") return true;
        if (process.platform === "win32") {
            var lower = name.toLowerCase();
            if (name.charAt(0) === "$") return true;
            if (WIN_HIDDEN_FOLDERS[lower] === true) return true;
        }
        return false;
    }

    // ============================================================
    // Folder browser (panel-internal)
    // ============================================================

    function pickFolderInternal(initPath, callback) {
        fb.callback = callback;
        fb.selectedPath = "";

        if (process.platform === "win32") {
            fb.drives = listWindowsDrives();
        }
        renderSidebar();

        var startPath = initPath && fs.existsSync(initPath) ? initPath : os.homedir();
        navigateTo(startPath);

        el.fbOverlay.classList.remove("hidden");
    }

    function closeFolderBrowser(result) {
        el.fbOverlay.classList.add("hidden");
        var cb = fb.callback;
        fb.callback = null;
        fb.selectedPath = "";
        if (cb) cb(result || null);
    }

    function renderSidebar() {
        while (el.fbSidebar.firstChild) el.fbSidebar.removeChild(el.fbSidebar.firstChild);

        var quickHeader = document.createElement("div");
        quickHeader.className = "fb-side-section";
        quickHeader.textContent = "Quick";
        el.fbSidebar.appendChild(quickHeader);

        addSidebarItem("🏠 Home", os.homedir());
        try {
            var desktop = path.join(os.homedir(), "Desktop");
            if (fs.existsSync(desktop)) addSidebarItem("🖥 Desktop", desktop);
        } catch (e) {}
        try {
            var docs = path.join(os.homedir(), "Documents");
            if (fs.existsSync(docs)) addSidebarItem("📄 Documents", docs);
        } catch (e) {}
        try {
            var dl = path.join(os.homedir(), "Downloads");
            if (fs.existsSync(dl)) addSidebarItem("⬇ Downloads", dl);
        } catch (e) {}

        if (process.platform === "win32" && fb.drives.length > 0) {
            var driveHeader = document.createElement("div");
            driveHeader.className = "fb-side-section";
            driveHeader.textContent = "Drives";
            el.fbSidebar.appendChild(driveHeader);
            for (var i = 0; i < fb.drives.length; i++) {
                var d = fb.drives[i];
                var label = d.Caption + (d.VolumeName ? " " + d.VolumeName : "");
                addSidebarItem("💾 " + label, d.Caption + "\\");
            }
        } else if (process.platform === "darwin") {
            try {
                var vols = fs.readdirSync("/Volumes");
                if (vols.length) {
                    var volHeader = document.createElement("div");
                    volHeader.className = "fb-side-section";
                    volHeader.textContent = "Volumes";
                    el.fbSidebar.appendChild(volHeader);
                    for (var v = 0; v < vols.length; v++) {
                        addSidebarItem("💾 " + vols[v], path.join("/Volumes", vols[v]));
                    }
                }
            } catch (e) {}
        }
    }

    function addSidebarItem(label, targetPath) {
        var item = document.createElement("div");
        item.className = "fb-side-item";
        item.textContent = label;
        item.title = targetPath;
        item.onclick = function () { navigateTo(targetPath); };
        el.fbSidebar.appendChild(item);
    }

    function navigateTo(targetPath) {
        if (!fs.existsSync(targetPath)) {
            setStatus("Folder not accessible: " + targetPath, "err");
            return;
        }
        fb.currentPath = targetPath;
        fb.selectedPath = targetPath;
        el.fbPathbar.textContent = targetPath;
        el.fbSelected.textContent = "Selected: " + targetPath;
        el.fbSelected.title = targetPath;

        while (el.fbList.firstChild) el.fbList.removeChild(el.fbList.firstChild);

        var entries;
        try {
            entries = fs.readdirSync(targetPath);
        } catch (e) {
            var errEl = document.createElement("div");
            errEl.className = "fb-empty";
            errEl.textContent = "Cannot read folder (permission denied?)";
            el.fbList.appendChild(errEl);
            return;
        }

        var folders = [];
        for (var i = 0; i < entries.length; i++) {
            var name = entries[i];
            if (isHiddenFolder(name)) continue;
            var full;
            try { full = path.join(targetPath, name); }
            catch (e) { continue; }
            var stat;
            try { stat = fs.statSync(full); }
            catch (e) { continue; }
            if (stat.isDirectory()) folders.push({ name: name, full: full });
        }
        folders.sort(function (a, b) {
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });

        if (folders.length === 0) {
            var empty = document.createElement("div");
            empty.className = "fb-empty";
            empty.textContent = "(no subfolders)";
            el.fbList.appendChild(empty);
            return;
        }

        for (var k = 0; k < folders.length; k++) {
            el.fbList.appendChild(buildFolderItem(folders[k]));
        }
    }

    function buildFolderItem(folder) {
        var item = document.createElement("div");
        item.className = "fb-item";

        var icon = document.createElement("span");
        icon.className = "fb-icon";
        icon.textContent = "📁";

        var name = document.createElement("span");
        name.className = "fb-name";
        name.textContent = folder.name;

        item.appendChild(icon);
        item.appendChild(name);

        item.onclick = function () {
            var all = el.fbList.querySelectorAll(".fb-item");
            for (var i = 0; i < all.length; i++) all[i].classList.remove("selected");
            item.classList.add("selected");
            fb.selectedPath = folder.full;
            el.fbSelected.textContent = "Selected: " + folder.full;
            el.fbSelected.title = folder.full;
        };
        item.ondblclick = function () {
            navigateTo(folder.full);
        };

        return item;
    }

    el.fbUpBtn.addEventListener("click", function () {
        try {
            var parent = path.dirname(fb.currentPath);
            if (parent && parent !== fb.currentPath) navigateTo(parent);
        } catch (e) {}
    });

    el.fbHomeBtn.addEventListener("click", function () {
        navigateTo(os.homedir());
    });

    el.fbRefreshBtn.addEventListener("click", function () {
        navigateTo(fb.currentPath);
    });

    el.fbCancelBtn.addEventListener("click", function () {
        closeFolderBrowser(null);
    });

    el.fbSelectBtn.addEventListener("click", function () {
        if (!fb.selectedPath) {
            setStatus("Select a folder first", "err");
            return;
        }
        closeFolderBrowser(fb.selectedPath);
    });

    // ============================================================
    // JSX bridge helpers
    // ============================================================

    function callJSX(fnName, payload, onDone) {
        var cmd;
        if (payload === undefined || payload === null) {
            cmd = fnName + "()";
        } else {
            var json = JSON.stringify(payload).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
            cmd = fnName + "('" + json + "')";
        }
        cs.evalScript(cmd, function (raw) {
            var parsed;
            try { parsed = JSON.parse(raw); }
            catch (e) { parsed = { ok: false, msg: "Bad JSX response: " + raw }; }
            onDone(parsed);
        });
    }

    // ============================================================
    // Project polling
    // ============================================================

    function pollProject() {
        if (state.polling) return;
        state.polling = true;
        callJSX("ws_getProjectInfo", null, function (res) {
            state.polling = false;

            if (!res.ok) {
                if (state.projectPath !== null) {
                    stopAutoSync();
                    state.projectPath = null;
                    state.projectId = null;
                    state.projectHost = res.host || null;
                    state.bins = [];
                    state.lastPickerPath = "";
                    state.autoSync = false;
                    renderProject();
                    renderBins();
                    refreshAutoSyncUI();
                }
                el.projName.textContent = "No project saved";
                el.projStatus.textContent = res.msg || "Save your project first";
                el.projStatus.className = "proj-status warn";
                updateHostBadge(res.host);
                setButtonsEnabled(false);
                return;
            }

            updateHostBadge(res.host);

            if (res.path !== state.projectPath) {
                if (state.projectPath) saveProjectData();
                stopAutoSync();
                state.projectPath = res.path;
                state.projectId = hashPath(res.path);
                state.projectHost = res.host;
                var data = loadProjectData(res.path);
                state.bins = data.bins;
                state.lastPickerPath = data.lastPickerPath;
                state.autoSync = data.autoSync;
                renderProject();
                renderBins();
                refreshAutoSyncUI();
                if (state.autoSync) startAutoSync();
            }
            setButtonsEnabled(true);
        });
    }

    function updateHostBadge(host) {
        el.hostBadge.className = "host-badge" + (host ? " " + host : "");
        el.hostBadge.textContent = host ? host.toUpperCase() : "—";
    }

    function setButtonsEnabled(enabled) {
        el.addBinBtn.disabled = !enabled;
        el.syncAllBtn.disabled = !enabled || state.bins.length === 0;
        el.autoSyncToggle.disabled = !enabled;
    }

    function renderProject() {
        if (!state.projectPath) {
            el.projName.textContent = "No project";
            return;
        }
        var name = path.basename(state.projectPath);
        el.projName.textContent = name;
        el.projName.title = state.projectPath;
        el.projStatus.textContent = state.bins.length + " bin(s) linked";
        el.projStatus.className = "proj-status";
    }

    // ============================================================
    // Bin rendering
    // ============================================================

    function renderBins() {
        while (el.binList.firstChild) el.binList.removeChild(el.binList.firstChild);

        if (state.bins.length === 0) {
            var empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = state.projectPath
                ? "No watch bins yet. Click \"Add Watch Bin\" or \"Link Existing Bin\" to start."
                : "Save your project to start.";
            el.binList.appendChild(empty);
            el.syncAllBtn.disabled = true;
            return;
        }

        for (var i = 0; i < state.bins.length; i++) {
            el.binList.appendChild(buildBinCard(state.bins[i]));
        }
        el.syncAllBtn.disabled = !state.projectPath;
    }

    function buildBinCard(bin) {
        var card = document.createElement("div");
        card.className = "bin-card";
        card.dataset.binId = bin.id;

        var head = document.createElement("div");
        head.className = "bin-head";
        var name = document.createElement("span");
        name.className = "bin-name";
        name.textContent = bin.name;
        var count = document.createElement("span");
        count.className = "bin-count";
        count.textContent = (bin.synced ? bin.synced.length : 0) + " synced";
        head.appendChild(name);
        head.appendChild(count);

        var pathEl = document.createElement("div");
        pathEl.className = "bin-path";
        pathEl.textContent = "📁 " + (bin.folderPath || "Not linked");
        pathEl.title = bin.folderPath;

        var meta = document.createElement("div");
        meta.className = "bin-meta";
        var lastSync = bin.lastSync ? timeAgo(bin.lastSync) : "never";
        var filterText = (bin.allowedExts && bin.allowedExts.length < DEFAULT_MEDIA_EXTS.length) ? " · Filtered" : " · All media";
        meta.textContent = "→ " + (bin.binPath || bin.name) + " · last sync: " + lastSync + (bin.recursive ? " · recursive" : "") + filterText;

        var actions = document.createElement("div");
        actions.className = "bin-actions";
        
        var openFolderBtn = document.createElement("button");
        openFolderBtn.textContent = "📂 Open";
        openFolderBtn.title = "Open this folder in OS Explorer";
        openFolderBtn.style.marginRight = "6px";
        openFolderBtn.style.backgroundColor = "#444"; 
        openFolderBtn.onclick = function() {
            var fp = bin.folderPath;
            if (!fs.existsSync(fp)) { showPopupAlert("⚠️ Folder no longer exists!"); return; }
            var cmd = process.platform === "win32" ? 'explorer "' + fp + '"' : 'open "' + fp + '"';
            require("child_process").exec(cmd);
        };

        var syncBtn = document.createElement("button");
        syncBtn.className = "primary";
        syncBtn.textContent = "Sync";
        syncBtn.onclick = function () { syncBin(bin); };
        
        var relinkBtn = document.createElement("button");
        relinkBtn.textContent = "Relink / Link Existing";
        relinkBtn.title = "Link folder and ignore existing files in Premiere Pro";
        relinkBtn.onclick = function () { relinkBin(bin); };

        var resetBtn = document.createElement("button");
        resetBtn.textContent = "Reset";
        resetBtn.title = "Forget synced history (re-import all next time)";
        resetBtn.onclick = function () { resetBin(bin); };
        
        var removeBtn = document.createElement("button");
        removeBtn.className = "danger";
        removeBtn.textContent = "✕";
        removeBtn.title = "Unlink this bin";
        removeBtn.onclick = function () { removeBin(bin); };
        
        actions.appendChild(openFolderBtn); 
        actions.appendChild(syncBtn);
        actions.appendChild(relinkBtn);
        actions.appendChild(resetBtn);
        actions.appendChild(removeBtn);

        card.appendChild(head);
        card.appendChild(pathEl);
        card.appendChild(meta);
        card.appendChild(actions);
        return card;
    }

    function timeAgo(iso) {
        try {
            var then = new Date(iso).getTime();
            var diff = Math.floor((Date.now() - then) / 1000);
            if (diff < 60)    return diff + "s ago";
            if (diff < 3600)  return Math.floor(diff / 60) + "m ago";
            if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
            return Math.floor(diff / 86400) + "d ago";
        } catch (e) { return "never"; }
    }

    // ============================================================
    // Custom UI Popup System
    // ============================================================
    function showPopupAlert(msg) {
        var existing = document.getElementById("ws-custom-alert");
        if (existing) existing.remove();

        var alertBox = document.createElement("div");
        alertBox.id = "ws-custom-alert";
        alertBox.textContent = msg;
        
        alertBox.style.position = "fixed";
        alertBox.style.top = "20px";
        alertBox.style.left = "50%";
        alertBox.style.transform = "translateX(-50%)";
        alertBox.style.backgroundColor = "#ff4a4a";
        alertBox.style.color = "#ffffff";
        alertBox.style.padding = "10px 20px";
        alertBox.style.borderRadius = "6px";
        alertBox.style.boxShadow = "0px 4px 15px rgba(0,0,0,0.4)";
        alertBox.style.zIndex = "10000";
        alertBox.style.fontWeight = "bold";
        alertBox.style.fontSize = "13px";
        alertBox.style.opacity = "0";
        alertBox.style.transition = "opacity 0.3s ease";
        alertBox.style.pointerEvents = "none";

        document.body.appendChild(alertBox);

        setTimeout(function() { alertBox.style.opacity = "1"; }, 10);

        setTimeout(function() {
            alertBox.style.opacity = "0";
            setTimeout(function() {
                if (alertBox.parentNode) alertBox.parentNode.removeChild(alertBox);
            }, 300);
        }, 3000);
    }

    function showConfirmDialog(title, message, confirmBtnText, isDanger, onConfirm) {
        var existing = document.getElementById("ws-confirm-overlay");
        if (existing) existing.remove();

        var overlay = document.createElement("div");
        overlay.id = "ws-confirm-overlay";
        overlay.style.position = "fixed";
        overlay.style.top = "0"; 
        overlay.style.left = "0";
        overlay.style.width = "100%"; 
        overlay.style.height = "100%";
        overlay.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.zIndex = "9999";
        overlay.style.opacity = "0";
        overlay.style.transition = "opacity 0.2s ease";

        var box = document.createElement("div");
        box.style.backgroundColor = "#2d2d2d"; 
        box.style.padding = "20px";
        box.style.borderRadius = "6px";
        box.style.boxShadow = "0px 10px 30px rgba(0,0,0,0.6)";
        box.style.width = "280px";
        box.style.textAlign = "left";
        box.style.color = "#eee";
        box.style.fontFamily = "inherit";

        var titleEl = document.createElement("h3");
        titleEl.textContent = title;
        titleEl.style.marginTop = "0";
        titleEl.style.marginBottom = "10px";
        titleEl.style.fontSize = "15px";

        var msgEl = document.createElement("p");
        msgEl.textContent = message;
        msgEl.style.fontSize = "13px";
        msgEl.style.color = "#bbb";
        msgEl.style.lineHeight = "1.4";
        msgEl.style.marginBottom = "25px";

        var btnRow = document.createElement("div");
        btnRow.style.display = "flex";
        btnRow.style.justifyContent = "flex-end";
        btnRow.style.gap = "10px";

        var cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        cancelBtn.style.padding = "6px 14px";
        cancelBtn.style.cursor = "pointer";
        cancelBtn.style.backgroundColor = "transparent";
        cancelBtn.style.color = "#ccc";
        cancelBtn.style.border = "1px solid #555";
        cancelBtn.style.borderRadius = "4px";
        cancelBtn.style.fontSize = "12px";
        cancelBtn.onclick = function() { 
            overlay.style.opacity = "0";
            setTimeout(function(){ overlay.remove(); }, 200);
        };

        var actionBtn = document.createElement("button");
        actionBtn.textContent = confirmBtnText;
        actionBtn.style.padding = "6px 14px";
        actionBtn.style.cursor = "pointer";
        actionBtn.style.border = "none";
        actionBtn.style.borderRadius = "4px";
        actionBtn.style.color = "#fff";
        actionBtn.style.fontSize = "12px";
        if (isDanger) {
            actionBtn.style.backgroundColor = "#b03a3a"; 
        } else {
            actionBtn.style.backgroundColor = "#246cd4"; 
        }
        actionBtn.onclick = function() {
            overlay.style.opacity = "0";
            setTimeout(function(){ 
                overlay.remove(); 
                onConfirm(); 
            }, 200);
        };

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(actionBtn);

        box.appendChild(titleEl);
        box.appendChild(msgEl);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        setTimeout(function() { overlay.style.opacity = "1"; }, 10);
    }

    // ============================================================
    // UI Injection for Extension Filter (CHECKBOXES)
    // ============================================================
    function setupExtensionFilterUI() {
        var container = document.getElementById("extFilterContainer");
        if (!container) {
            container = document.createElement("div");
            container.id = "extFilterContainer";
            container.style.marginTop = "10px";
            container.style.marginBottom = "10px";
            
            var label = document.createElement("label");
            label.textContent = "ALLOWED MEDIA TYPES:";
            label.style.display = "block";
            label.style.fontSize = "12px";
            label.style.marginBottom = "6px";
            label.style.color = "#ccc";

            var cbWrapper = document.createElement("div");
            cbWrapper.style.display = "flex";
            cbWrapper.style.gap = "15px";

            function createCb(id, text, checked) {
                var lbl = document.createElement("label");
                lbl.style.fontSize = "13px";
                lbl.style.color = "#eee";
                lbl.style.cursor = "pointer";
                lbl.style.display = "flex";
                lbl.style.alignItems = "center";
                lbl.style.gap = "5px";

                var cb = document.createElement("input");
                cb.type = "checkbox";
                cb.id = id;
                cb.checked = checked;

                lbl.appendChild(cb);
                lbl.appendChild(document.createTextNode(text));
                return lbl;
            }

            cbWrapper.appendChild(createCb("chkVideo", "Video", true));
            cbWrapper.appendChild(createCb("chkAudio", "Audio", true));
            cbWrapper.appendChild(createCb("chkImage", "Image", true));

            container.appendChild(label);
            container.appendChild(cbWrapper);
            
            el.recursiveInput.parentNode.parentNode.insertBefore(container, el.recursiveInput.parentNode);
        } else {
            document.getElementById("chkVideo").checked = true;
            document.getElementById("chkAudio").checked = true;
            document.getElementById("chkImage").checked = true;
        }
    }

    // ============================================================
    // DEDICATED "LINK EXISTING BIN" BUTTON
    // ============================================================
    var isLinkingExisting = false;

    var linkExistingBtn = document.createElement("button");
    linkExistingBtn.textContent = "Link Existing Bin";
    linkExistingBtn.className = el.addBinBtn.className;
    linkExistingBtn.style.marginLeft = "8px"; 
    el.addBinBtn.parentNode.insertBefore(linkExistingBtn, el.addBinBtn.nextSibling);

    linkExistingBtn.addEventListener("click", function() {
        isLinkingExisting = true;
        el.modalTitle.textContent = "Link Existing Bin (Ignore Existing)";
        el.folderInput.value = "";
        el.binNameInput.value = "";
        el.binPathInput.value = "";
        el.binPathInput.dataset.touched = "";
        el.recursiveInput.checked = true;
        setupExtensionFilterUI();
        el.modal.classList.remove("hidden");
        setTimeout(function () { el.binNameInput.focus(); }, 0);
    });

    // ============================================================
    // Bin modal logic
    // ============================================================

    function openAddBinModal() {
        isLinkingExisting = false;
        el.modalTitle.textContent = "Add Watch Bin (Fresh Import)";
        el.folderInput.value = "";
        el.binNameInput.value = "";
        el.binPathInput.value = "";
        el.binPathInput.dataset.touched = "";
        el.recursiveInput.checked = true;
        setupExtensionFilterUI();
        el.modal.classList.remove("hidden");
        setTimeout(function () { el.binNameInput.focus(); }, 0);
    }

    function closeModal() {
        el.modal.classList.add("hidden");
    }

    el.addBinBtn.addEventListener("click", openAddBinModal);
    el.modalCancelBtn.addEventListener("click", closeModal);

    el.browseBtn.addEventListener("click", function () {
        var initPath = state.lastPickerPath;
        if (!initPath && state.bins.length > 0) {
            try { initPath = path.dirname(state.bins[state.bins.length - 1].folderPath); }
            catch (e) {}
        }
        pickFolderInternal(initPath, function (folderPath) {
            if (!folderPath) {
                setStatus("Cancelled", "");
                return;
            }
            el.folderInput.value = folderPath;
            if (!el.binNameInput.value) {
                el.binNameInput.value = path.basename(folderPath);
            }
            if (!el.binPathInput.value) {
                el.binPathInput.value = el.binNameInput.value;
            }
            try {
                state.lastPickerPath = path.dirname(folderPath);
                saveProjectData();
            } catch (e) {}
            setStatus("Folder selected", "ok");
        });
    });

    el.binNameInput.addEventListener("input", function () {
        if (!el.binPathInput.dataset.touched) {
            el.binPathInput.value = el.binNameInput.value;
        }
    });
    el.binPathInput.addEventListener("input", function () {
        el.binPathInput.dataset.touched = "1";
    });

    el.modalSaveBtn.addEventListener("click", function () {
        var folderPath = el.folderInput.value.trim();
        var binName = el.binNameInput.value.trim();
        var binPath = el.binPathInput.value.trim() || binName;
        var recursive = el.recursiveInput.checked;

        if (!folderPath) { setStatus("Pick a folder first", "err"); return; }
        if (!binName)    { setStatus("Bin name required", "err"); return; }
        if (!fs.existsSync(folderPath)) {
            setStatus("Folder does not exist", "err");
            return;
        }

        var isDuplicate = false;
        var newPathNorm = path.normalize(folderPath).toLowerCase();
        
        for (var i = 0; i < state.bins.length; i++) {
            var existingPathNorm = path.normalize(state.bins[i].folderPath).toLowerCase();
            if (existingPathNorm === newPathNorm) {
                isDuplicate = true;
                break;
            }
        }

        if (isDuplicate) {
            showPopupAlert("⚠️ This folder is already linked!");
            return; 
        }

        var allowedExts = [];
        if (document.getElementById("chkVideo").checked) allowedExts = allowedExts.concat(EXT_GROUPS.video);
        if (document.getElementById("chkAudio").checked) allowedExts = allowedExts.concat(EXT_GROUPS.audio);
        if (document.getElementById("chkImage").checked) allowedExts = allowedExts.concat(EXT_GROUPS.image);

        if (allowedExts.length === 0) {
            showPopupAlert("⚠️ Please select at least one media type!");
            return;
        }

        var bin = {
            id: "wb_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
            name: binName,
            binPath: binPath,
            folderPath: folderPath,
            recursive: recursive,
            allowedExts: allowedExts,
            synced: [],
            lastSync: null
        };

        if (isLinkingExisting) {
            setStatus("Fetching existing files from Premiere Pro...", "");
            callJSX("ws_getBinExistingFiles", { binPath: binPath }, function(res) {
                if (res.ok && res.files) {
                    bin.synced = res.files; 
                }
                bin.lastSync = new Date().toISOString();
                
                state.bins.push(bin);
                saveProjectData();
                renderProject();
                renderBins();
                closeModal();
                setStatus("Linked existing bin: " + binName + ". Ignored " + (res.files ? res.files.length : 0) + " items.", "ok");
            });
        } else {
            state.bins.push(bin);
            saveProjectData();
            renderProject();
            renderBins();
            closeModal();
            setStatus("Bin added: " + binName, "ok");
        }
    });

    // ============================================================
    // Folder scanning (with subfolder hierarchy tracking)
    // Returns: [ { fsName: "C:\...", relDir: "Sub/Nested" }, ... ]
    // ============================================================

    function scanFolder(folder, recursive, allowedExts, rootFolder) {
        if (!rootFolder) rootFolder = folder;
        var out = [];
        var entries;
        try { entries = fs.readdirSync(folder); }
        catch (e) { return out; }

        for (var i = 0; i < entries.length; i++) {
            var name = entries[i];
            if (name.charAt(0) === ".") continue;
            var full = path.join(folder, name);
            var stat;
            try { stat = fs.statSync(full); }
            catch (e) { continue; }

            if (stat.isFile()) {
                var ext = path.extname(name).toLowerCase();
                var listToCheck = (allowedExts && allowedExts.length > 0) ? allowedExts : DEFAULT_MEDIA_EXTS;
                if (listToCheck.indexOf(ext) !== -1) {
                    var rel = path.relative(rootFolder, path.dirname(full));
                    out.push({ fsName: full, relDir: rel || "" });
                }
            } else if (stat.isDirectory() && recursive) {
                out = out.concat(scanFolder(full, true, allowedExts, rootFolder));
            }
        }
        return out;
    }

    // ============================================================
    // File stability check (in-memory per bin)
    // Returns true only if file's size+mtime match the previous tick.
    // ============================================================

    function checkStable(filePath, pendingMap) {
        var stat;
        try { stat = fs.statSync(filePath); }
        catch (e) { return false; }
        var sig = stat.size + ":" + Math.floor(stat.mtimeMs || 0);
        var prev = pendingMap[filePath];
        if (prev === sig) {
            delete pendingMap[filePath];
            return true;
        }
        pendingMap[filePath] = sig;
        return false;
    }

    // ============================================================
    // Sync (manual)
    // ============================================================

    function syncBin(bin) {
        if (state.manualSyncBusy || state.autoSyncBusy) {
            setStatus("Sync already running...", "");
            return;
        }
        if (!state.projectPath) { setStatus("No project", "err"); return; }
        if (!fs.existsSync(bin.folderPath)) {
            setStatus("Folder missing: " + bin.folderPath, "err");
            return;
        }

        state.manualSyncBusy = true;
        setStatus("Scanning " + bin.name + "...", "");

        var allFiles = scanFolder(bin.folderPath, bin.recursive, bin.allowedExts, bin.folderPath);
        var syncedSet = {};
        if (bin.synced) {
            for (var i = 0; i < bin.synced.length; i++) {
                syncedSet[path.normalize(bin.synced[i]).toLowerCase()] = true;
            }
        }
        var newFiles = []; 
        for (var j = 0; j < allFiles.length; j++) {
            var normPath = path.normalize(allFiles[j].fsName).toLowerCase();
            if (!syncedSet[normPath]) newFiles.push(allFiles[j]);
        }

        if (newFiles.length === 0) {
            bin.lastSync = new Date().toISOString();
            saveProjectData();
            renderBins();
            setStatus(bin.name + ": no new files", "ok");
            state.manualSyncBusy = false;
            return;
        }

        setStatus("Importing " + newFiles.length + " file(s) into " + bin.name + "...", "");

        callJSX("ws_importToBin", { files: newFiles, binPath: bin.binPath }, function (res) {
            state.manualSyncBusy = false;
            if (!res.ok) {
                setStatus("Sync failed: " + (res.msg || "unknown"), "err");
                return;
            }
            for (var k = 0; k < newFiles.length; k++) {
                bin.synced.push(newFiles[k].fsName);
            }
            bin.lastSync = new Date().toISOString();
            saveProjectData();
            renderBins();
            setStatus(bin.name + ": imported " + (res.imported || 0) + " of " + newFiles.length, "ok");
        });
    }

    function syncAll() {
        if (state.manualSyncBusy || state.autoSyncBusy) {
            setStatus("Sync already running...", "");
            return;
        }
        if (state.bins.length === 0) return;

        state.manualSyncBusy = true;
        var i = 0;
        function next() {
            if (i >= state.bins.length) {
                state.manualSyncBusy = false;
                setStatus("Sync All complete", "ok");
                return;
            }
            var bin = state.bins[i++];
            if (!fs.existsSync(bin.folderPath)) { next(); return; }
            
            var allFiles = scanFolder(bin.folderPath, bin.recursive, bin.allowedExts, bin.folderPath);
            var syncedSet = {};
            if (bin.synced) {
                for (var s = 0; s < bin.synced.length; s++) {
                    syncedSet[path.normalize(bin.synced[s]).toLowerCase()] = true;
                }
            }
            
            var newFiles = [];
            for (var j = 0; j < allFiles.length; j++) {
                var normPath = path.normalize(allFiles[j].fsName).toLowerCase();
                if (!syncedSet[normPath]) newFiles.push(allFiles[j]);
            }
            
            if (newFiles.length === 0) {
                bin.lastSync = new Date().toISOString();
                saveProjectData();
                renderBins();
                next();
                return;
            }
            
            setStatus("Syncing " + bin.name + " (" + newFiles.length + ")...", "");
            callJSX("ws_importToBin", { files: newFiles, binPath: bin.binPath }, function (res) {
                if (res.ok) {
                    for (var k = 0; k < newFiles.length; k++) bin.synced.push(newFiles[k].fsName);
                    bin.lastSync = new Date().toISOString();
                    saveProjectData();
                    renderBins();
                }
                next();
            });
        }
        next();
    }

    el.syncAllBtn.addEventListener("click", syncAll);

    // ============================================================
    // Auto-sync — silent ticking, file stability check
    // ============================================================

    function isModalOpen() {
        return !el.modal.classList.contains("hidden") ||
               !el.fbOverlay.classList.contains("hidden");
    }

    function refreshAutoSyncUI() {
        var on = !!state.autoSync;
        el.autoSyncToggle.checked = on;
        el.autoSyncDot.classList.remove("on", "busy");
        el.autoSyncInfo.classList.remove("on", "busy");
        if (state.autoSyncBusy) {
            el.autoSyncDot.classList.add("busy");
            el.autoSyncInfo.classList.add("busy");
            el.autoSyncInfo.textContent = "syncing...";
        } else if (on) {
            el.autoSyncDot.classList.add("on");
            el.autoSyncInfo.classList.add("on");
            el.autoSyncInfo.textContent = "every 5s";
        } else {
            el.autoSyncInfo.textContent = "off";
        }
    }

    function startAutoSync() {
        if (state.autoSyncTimer) return;
        state.autoSyncTimer = setInterval(autoSyncTick, AUTO_SYNC_INTERVAL_MS);
    }

    function stopAutoSync() {
        if (state.autoSyncTimer) {
            clearInterval(state.autoSyncTimer);
            state.autoSyncTimer = null;
        }
        // Clear pending stability maps
        if (state.bins) {
            for (var i = 0; i < state.bins.length; i++) {
                if (state.bins[i]._pending) state.bins[i]._pending = {};
            }
        }
        state.autoSyncBusy = false;
    }

    function autoSyncTick() {
        if (state.autoSyncBusy) return;
        if (state.manualSyncBusy) return;
        if (!state.projectPath) return;
        if (!state.bins || state.bins.length === 0) return;
        if (isModalOpen()) return;

        // Process bins sequentially to avoid AE/PPro race conditions
        state.autoSyncBusy = true;
        refreshAutoSyncUI();

        var idx = 0;
        function processNext() {
            if (idx >= state.bins.length) {
                state.autoSyncBusy = false;
                refreshAutoSyncUI();
                return;
            }
            var bin = state.bins[idx++];

            if (!fs.existsSync(bin.folderPath)) { processNext(); return; }

            // Init pending stability map if missing
            if (!bin._pending) bin._pending = {};

            var allFiles;
            try {
                allFiles = scanFolder(bin.folderPath, bin.recursive, bin.allowedExts, bin.folderPath);
            } catch (e) {
                processNext();
                return;
            }

            // Build synced lookup
            var syncedSet = {};
            if (bin.synced) {
                for (var i = 0; i < bin.synced.length; i++) {
                    syncedSet[path.normalize(bin.synced[i]).toLowerCase()] = true;
                }
            }

            // Filter to new files, then keep only those that pass stability check
            var stableNewFiles = [];
            var seenInThisScan = {};
            for (var j = 0; j < allFiles.length; j++) {
                var f = allFiles[j];
                var normPath = path.normalize(f.fsName).toLowerCase();
                seenInThisScan[f.fsName] = true;
                if (syncedSet[normPath]) continue;
                if (checkStable(f.fsName, bin._pending)) {
                    stableNewFiles.push(f);
                }
            }

            // Clean up pending entries for files that disappeared (deleted/moved)
            for (var key in bin._pending) {
                if (!seenInThisScan[key]) delete bin._pending[key];
            }

            if (stableNewFiles.length === 0) {
                processNext();
                return;
            }

            // Highlight bin card (visual feedback)
            highlightBinCard(bin.id, true);
            setStatus("Auto: importing " + stableNewFiles.length + " into " + bin.name + "...", "");

            callJSX("ws_importToBin", { files: stableNewFiles, binPath: bin.binPath }, function (res) {
                highlightBinCard(bin.id, false);
                if (res && res.ok) {
                    for (var k = 0; k < stableNewFiles.length; k++) {
                        bin.synced.push(stableNewFiles[k].fsName);
                    }
                    bin.lastSync = new Date().toISOString();
                    saveProjectData();
                    renderBins();
                    setStatus("Auto: imported " + (res.imported || 0) + " into " + bin.name, "ok");
                } else {
                    setStatus("Auto-sync error: " + (res ? res.msg : "unknown"), "err");
                }
                // Continue to next bin even on failure
                processNext();
            });
        }

        processNext();
    }

    function highlightBinCard(binId, on) {
        var card = document.querySelector('.bin-card[data-bin-id="' + binId + '"]');
        if (!card) return;
        if (on) card.classList.add("syncing");
        else card.classList.remove("syncing");
    }

    el.autoSyncToggle.addEventListener("change", function () {
        if (!state.projectPath) {
            this.checked = false;
            showPopupAlert("⚠️ Open a saved project first");
            return;
        }
        state.autoSync = !!this.checked;
        saveProjectData();
        refreshAutoSyncUI();
        if (state.autoSync) {
            startAutoSync();
            setStatus("Auto-sync enabled (every 5s)", "ok");
        } else {
            stopAutoSync();
            refreshAutoSyncUI();
            setStatus("Auto-sync disabled", "");
        }
    });

    // ============================================================
    // Bin actions 
    // ============================================================

    function relinkBin(bin) {
        pickFolderInternal(bin.folderPath, function (newFolderPath) {
            if (!newFolderPath) return;
            
            var newPathNorm = path.normalize(newFolderPath).toLowerCase();
            var currentPathNorm = path.normalize(bin.folderPath).toLowerCase();

            if (newPathNorm === currentPathNorm) {
                showPopupAlert("⚠️ Already linked to this exact folder!");
                setStatus("Already linked to this folder", "ok");
                return;
            }

            var isDuplicate = false;
            for (var i = 0; i < state.bins.length; i++) {
                if (state.bins[i].id !== bin.id) { 
                    var existingPathNorm = path.normalize(state.bins[i].folderPath).toLowerCase();
                    if (existingPathNorm === newPathNorm) {
                        isDuplicate = true;
                        break;
                    }
                }
            }

            if (isDuplicate) {
                showPopupAlert("⚠️ This folder is already linked to another bin!");
                return;
            }

            setStatus("Linking folder and fetching existing files...", "");
            
            callJSX("ws_getBinExistingFiles", { binPath: bin.binPath }, function(res) {
                if (!res.ok) {
                    setStatus("Failed to fetch existing files.", "err");
                    return;
                }

                bin.synced = res.files || [];
                bin.folderPath = newFolderPath;
                bin._pending = {}; // reset stability map
                bin.lastSync = new Date().toISOString();
                
                saveProjectData();
                renderProject();
                renderBins();
                
                setStatus("Folder linked! " + bin.synced.length + " existing files will be ignored.", "ok");
            });
        });
    }

    function resetBin(bin) {
        showConfirmDialog(
            "Reset Synced History",
            "Are you sure you want to reset history for \"" + bin.name + "\"? The next sync will re-import all files in this folder.",
            "Reset",
            true,
            function() {
                bin.synced = [];
                bin._pending = {};
                bin.lastSync = null;
                saveProjectData();
                renderBins();
                setStatus("Reset: " + bin.name, "ok");
            }
        );
    }

    function removeBin(bin) {
        showConfirmDialog(
            "Unlink Watch Bin",
            "Unlink \"" + bin.name + "\"? Files already imported into the Premiere Pro project will not be deleted.",
            "Unlink",
            true, 
            function() {
                for (var i = 0; i < state.bins.length; i++) {
                    if (state.bins[i].id === bin.id) {
                        state.bins.splice(i, 1);
                        break;
                    }
                }
                saveProjectData();
                renderProject();
                renderBins();
                setStatus("Unlinked: " + bin.name, "ok");
            }
        );
    }

    // ============================================================
    // Status
    // ============================================================

    function setStatus(msg, kind) {
        el.status.textContent = msg;
        el.status.className = kind || "";
    }

    // ============================================================
    // Init
    // ============================================================

    refreshAutoSyncUI();
    pollProject();
    setInterval(pollProject, POLL_INTERVAL_MS);

})();
