/*
========================================================================
  Script Name: QuickBinSync (host script)
  Author: Raisul Sohan
  Website: https://raisulsohan.com
  Description: Folder-to-bin sync host backend for After Effects and Premiere Pro.
  Copyright (c) 2026 Raisul Sohan. All rights reserved.
========================================================================
*/

// ---------- Minimal JSON safety net (modern AE/PPro have JSON natively) ----------
if (typeof JSON === "undefined" || !JSON.stringify) {
    JSON = (typeof JSON !== "undefined") ? JSON : {};
    JSON.stringify = JSON.stringify || function (o) {
        if (o === null) return "null";
        var t = typeof o;
        if (t === "number" || t === "boolean") return String(o);
        if (t === "string") return '"' + o.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
        if (o instanceof Array) {
            var a = [];
            for (var i = 0; i < o.length; i++) a.push(JSON.stringify(o[i]));
            return "[" + a.join(",") + "]";
        }
        if (t === "object") {
            var p = [];
            for (var k in o) if (o.hasOwnProperty(k)) p.push('"' + k + '":' + JSON.stringify(o[k]));
            return "{" + p.join(",") + "}";
        }
        return "null";
    };
    JSON.parse = JSON.parse || function (s) { return eval("(" + s + ")"); };
}

// ============================================================
// QuickBinSync module
// ============================================================
var WS = (function () {

    function reply(ok, msg, extra) {
        var o = { ok: ok, msg: msg };
        if (extra) for (var k in extra) o[k] = extra[k];
        return JSON.stringify(o);
    }

    // ---------- Host detection (feature-based, more reliable than appName) ----------
    function isAE() {
        try {
            return typeof CompItem !== "undefined"
                && typeof FolderItem !== "undefined"
                && typeof app.project.importFile === "function";
        } catch (e) { return false; }
    }
    function isPPRO() {
        try {
            return app.project
                && app.project.rootItem
                && typeof app.project.importFiles === "function";
        } catch (e) { return false; }
    }
    function hostName() {
        if (isAE())   return "ae";
        if (isPPRO()) return "ppro";
        return "unknown";
    }

    // ---------- Project info ----------
    function getProjectInfo() {
        try {
            var host = hostName();
            if (host === "unknown") return reply(false, "Unsupported host", { host: host });
            if (!app.project) return reply(false, "No project", { host: host });

            var savedPath = "";
            try {
                if (app.project.file && app.project.file.fsName) {
                    savedPath = String(app.project.file.fsName);
                }
            } catch (e1) {}
            if (!savedPath) {
                try {
                    if (typeof app.project.path === "string" && app.project.path.length > 0) {
                        savedPath = app.project.path;
                    }
                } catch (e2) {}
            }

            if (!savedPath) {
                return reply(false, "Save your project first", { host: host, saved: false });
            }
            return reply(true, "OK", { host: host, saved: true, path: savedPath });
        } catch (e) {
            return reply(false, "Error: " + e.toString());
        }
    }

    // ---------- Folder picker ----------
    function pickFolder() {
        try {
            var f = Folder.selectDialog("Choose folder to watch");
            if (!f) return reply(false, "Cancelled");
            return reply(true, "OK", { path: String(f.fsName) });
        } catch (e) {
            return reply(false, "Error: " + e.toString());
        }
    }

    // ============================================================
    // AE: bin (FolderItem) helpers
    // ============================================================
    function ae_findChildFolder(name, parent) {
        if (!parent) parent = app.project.rootFolder;
        for (var i = 1; i <= parent.numItems; i++) {
            var item = parent.item(i);
            if (item instanceof FolderItem && item.name === name) return item;
        }
        return null;
    }
    function ae_ensureFolderPath(pathStr) {
        var parts = pathStr.split("/");
        var current = app.project.rootFolder;
        for (var i = 0; i < parts.length; i++) {
            var name = parts[i];
            if (!name) continue;
            var found = ae_findChildFolder(name, current);
            if (!found) {
                found = app.project.items.addFolder(name);
                found.parentFolder = current;
            }
            current = found;
        }
        return current;
    }
    function ae_getAllMediaPathsInFolder(folder, outArray) {
        for (var i = 1; i <= folder.numItems; i++) {
            var item = folder.item(i);
            if (item instanceof FolderItem) {
                ae_getAllMediaPathsInFolder(item, outArray);
            } else if (item instanceof FootageItem && item.mainSource && item.mainSource.file) {
                outArray.push(File.decode(item.mainSource.file.fsName));
            }
        }
    }

    // ============================================================
    // PPro: bin (ProjectItem of type BIN) helpers
    // ============================================================
    function ppro_findChildBin(name, parent) {
        if (!parent) parent = app.project.rootItem;
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            try {
                if (child.name === name && child.children && typeof child.createBin === "function") {
                    return child;
                }
            } catch (e) {}
        }
        return null;
    }
    function ppro_ensureBinPath(pathStr) {
        var parts = pathStr.split("/");
        var current = app.project.rootItem;
        for (var i = 0; i < parts.length; i++) {
            var name = parts[i];
            if (!name) continue;
            var found = ppro_findChildBin(name, current);
            if (!found) {
                try { found = current.createBin(name); }
                catch (e) { return null; }
            }
            current = found;
        }
        return current;
    }
    function ppro_getAllMediaPathsInBin(bin, outArray) {
        for (var i = 0; i < bin.children.numItems; i++) {
            var child = bin.children[i];
            // In PPro, type 2 is generally a Bin. We also check if it has 'createBin'
            if (child.type == 2 || typeof child.createBin === "function") {
                ppro_getAllMediaPathsInBin(child, outArray);
            } else {
                try {
                    var mp = child.getMediaPath();
                    if (mp) outArray.push(File.decode(mp));
                } catch(e) {}
            }
        }
    }

    // ============================================================
    // Import to bin (With Subfolder Hierarchy Support)
    // ============================================================
    function importToBin(payloadJson) {
        try {
            var p = JSON.parse(payloadJson);
            var files = p.files || [];
            var binPath = p.binPath || "";

            if (!files.length) return reply(true, "Nothing to sync", { imported: 0 });

            // -------- After Effects branch --------
            if (isAE()) {
                var imported = 0, failed = 0;
                app.beginUndoGroup("QuickBinSync Import");
                try {
                    for (var i = 0; i < files.length; i++) {
                        try {
                            // Extract properties from payload object
                            var isObj = (typeof files[i] === "object");
                            var fsName = isObj ? files[i].fsName : files[i];
                            var relDir = isObj ? files[i].relDir : "";
                            
                            var fObj = new File(fsName);
                            if (!fObj.exists) { failed++; continue; }
                            
                            // Build nested path
                            var targetBinPath = binPath + (relDir ? "/" + relDir : "");
                            var folder = ae_ensureFolderPath(targetBinPath);
                            
                            var io = new ImportOptions(fObj);
                            var item = app.project.importFile(io);
                            if (item) {
                                try { item.parentFolder = folder; } catch (eMove) {}
                                imported++;
                            } else {
                                failed++;
                            }
                        } catch (eImp) {
                            failed++;
                        }
                    }
                } catch (eAll) {
                    app.endUndoGroup();
                    return reply(false, "AE import failed: " + eAll.toString());
                }
                app.endUndoGroup();
                return reply(true, "OK", { imported: imported, failed: failed });
            }

            // -------- Premiere Pro branch --------
            if (isPPRO()) {
                try { app.enableQE(); } catch (eQE) {}

                // Group files by their destination nested folder
                var groups = {};
                for (var i = 0; i < files.length; i++) {
                    var isObj = (typeof files[i] === "object");
                    var fsName = isObj ? files[i].fsName : files[i];
                    var relDir = isObj ? files[i].relDir : "";
                    var targetBinPath = binPath + (relDir ? "/" + relDir : "");
                    
                    if (!groups[targetBinPath]) groups[targetBinPath] = [];
                    groups[targetBinPath].push(fsName);
                }

                var totalImported = 0;
                var totalFailed = 0;

                for (var targetPath in groups) {
                    var bin = ppro_ensureBinPath(targetPath);
                    if (!bin) { totalFailed += groups[targetPath].length; continue; }

                    var beforeIds = {};
                    try {
                        for (var b = 0; b < bin.children.numItems; b++) {
                            try { beforeIds[bin.children[b].nodeId] = true; } catch (eId) {}
                        }
                    } catch (eS) {}

                    try {
                        app.project.importFiles(groups[targetPath], false, bin, false);
                    } catch (eP) {
                        totalFailed += groups[targetPath].length; 
                        continue; 
                    }

                    try {
                        for (var c = 0; c < bin.children.numItems; c++) {
                            try {
                                if (!beforeIds[bin.children[c].nodeId]) totalImported++;
                            } catch (eN) {}
                        }
                    } catch (eC) {}
                }

                var failedCount = files.length - totalImported;
                if (failedCount < 0) failedCount = 0;
                return reply(true, "OK", { imported: totalImported, failed: failedCount });
            }

            return reply(false, "Unsupported host");
        } catch (e) {
            return reply(false, "Error: " + e.toString());
        }
    }

    // ============================================================
    // Get existing files in a bin (Recursively searches subfolders)
    // ============================================================
    function getBinExistingFiles(payloadJson) {
        try {
            var p = JSON.parse(payloadJson);
            var binPath = p.binPath || "";
            var existingFiles = [];

            if (!binPath) return reply(false, "Bin path missing");

            // -------- After Effects branch --------
            if (isAE()) {
                var folderName = binPath.split("/").pop();
                var folder = ae_findChildFolder(folderName, null);
                
                if (folder) ae_getAllMediaPathsInFolder(folder, existingFiles);
                return reply(true, "OK", { files: existingFiles });
            }

            // -------- Premiere Pro branch --------
            if (isPPRO()) {
                var binName = binPath.split("/").pop();
                var bin = ppro_findChildBin(binName, null);
                
                if (bin) ppro_getAllMediaPathsInBin(bin, existingFiles);
                return reply(true, "OK", { files: existingFiles });
            }

            return reply(false, "Unsupported host");
        } catch (e) {
            return reply(false, "Error: " + e.toString());
        }
    }

    // ---------- Public API ----------
    return {
        getProjectInfo: getProjectInfo,
        pickFolder:     pickFolder,
        importToBin:    importToBin,
        getBinExistingFiles: getBinExistingFiles,
        ping: function () { return reply(true, "pong", { host: hostName() }); }
    };
})();

// ============================================================
// Top-level functions exposed for evalScript
// ============================================================
function ws_getProjectInfo()    { return WS.getProjectInfo(); }
function ws_pickFolder()        { return WS.pickFolder(); }
function ws_importToBin(json)   { return WS.importToBin(json); }
function ws_getBinExistingFiles(json) { return WS.getBinExistingFiles(json); }
function ws_ping()              { return WS.ping(); }