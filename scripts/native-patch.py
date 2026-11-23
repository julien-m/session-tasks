#!/usr/bin/env python3
"""Stages, verifies and atomically installs the local Codex summary patch."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[1]
VERSION = "26.1117.41037"
BUILD = "29803"
PATCH = "1.0.0"
ARCHIVE = "Contents/Resources/app.asar"
PLIST = "Contents/Info.plist"
MAIN = ".vite/build/early-bootstrap-916-90e0adb52d70fbc5.js"
PRELOAD = ".vite/build/preload.js"
VIEW = "webview/assets/async/107353.17860c892b.js"
READER = ".vite/build/session-tasks-native-reader.cjs"
DIRECT_LIBRARIES = (
    "Contents/Frameworks/Codex Framework.framework/Versions/158.0.8127.37/Libraries/libaperitif.dylib",
    "Contents/Frameworks/Codex Framework.framework",
)
CHANNEL = "session-tasks-native:read-board"
SOURCE_SIBLINGS = "children:[R,x,p,y,v,b,_,C,I]"
BLOCK_SIZE = 4 * 1024 * 1024


def run(*args, timeout=120):
    """Run a bounded local bundle or syntax verification command."""
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_header(stream):
    """Read the Electron Pickle framing and return the archive file-table base offset."""
    raw = stream.read(16)
    _, padded, payload, length = struct.unpack("<IIII", raw)
    if not 0 < length <= payload - 4 or length > 16_000_000 or padded != payload + 4:
        raise ValueError("invalid archive header")
    return json.loads(stream.read(length)), 8 + padded


def entry(tree, path):
    for part in path.split("/"):
        tree = tree["files"][part]
    return tree


def read_member(path, member):
    with path.open("rb") as stream:
        tree, base = read_header(stream)
        item = entry(tree, member)
        stream.seek(base + int(item["offset"]))
        return stream.read(item["size"])


def replace_once(source, anchor, replacement):
    if source.count(anchor) != 1:
        raise ValueError(f"expected a single anchor: {anchor}")
    return source.replace(anchor, replacement, 1)


def modifications(archive):
    main = read_member(archive, MAIN).decode()
    preload = read_member(archive, PRELOAD).decode()
    view = read_member(archive, VIEW).decode()
    # The native renderer is already checked by the same trust predicate used by Codex's own IPC.
    anchor = "tg.ipcMain.handle(l5.g2,async(e,t,r)=>{if(!A(e))"
    handler = f'tg.ipcMain.handle("{CHANNEL}",async(e,id)=>A(e)&&e.senderFrame===e.sender.mainFrame?require("./session-tasks-native-reader.cjs").readBoard(id):null);'
    main = replace_once(main, anchor, handler + anchor)
    anchor = 'getInitialSidebarBootstrap:()=>n.ipcRenderer.sendSync('
    preload = replace_once(preload, anchor, f'readSessionTasks:id=>n.ipcRenderer.invoke("{CHANNEL}",id),' + anchor)
    view = replace_once(view, SOURCE_SIBLINGS, "children:[R,x,p,y,v,b,(0,a.jsx)(SessionTasksNative,{threadId:T},T),_,C,I]")
    anchor = "function ez(e){return e.libraryFileId}"
    view = replace_once(view, anchor, (ROOT / "native/summary-section.js").read_text() + "\n" + anchor)
    return {MAIN: main.encode(), PRELOAD: preload.encode(), VIEW: view.encode(),
            READER: (ROOT / "native/read-board.cjs").read_bytes()}


def pack(archive, output, changes):
    """Append replaced members and update only their file-table entries and integrity."""
    with archive.open("rb") as source:
        tree, base = read_header(source)
        offset = archive.stat().st_size - base
        for name, contents in changes.items():
            folder, filename = name.rsplit("/", 1)
            entry(tree, folder)["files"][filename] = {
                "size": len(contents), "offset": str(offset),
                "integrity": {"algorithm": "SHA256", "hash": hashlib.sha256(contents).hexdigest(),
                              "blockSize": BLOCK_SIZE, "blocks": [
                                  hashlib.sha256(contents[i:i + BLOCK_SIZE]).hexdigest()
                                  for i in range(0, len(contents), BLOCK_SIZE)]},
            }
            offset += len(contents)
        encoded = json.dumps(tree, separators=(",", ":"), ensure_ascii=False).encode()
        payload = struct.pack("<I", len(encoded)) + encoded
        payload += b"\0" * (-len(payload) % 4)
        with output.open("xb") as destination:
            destination.write(struct.pack("<III", 4, len(payload) + 4, len(payload)))
            destination.write(payload)
            source.seek(base)
            shutil.copyfileobj(source, destination, BLOCK_SIZE)
            for contents in changes.values():
                destination.write(contents)
        for member, contents in changes.items():
            if read_member(output, member) != contents:
                raise ValueError(f"archive readback mismatch: {member}")
        return hashlib.sha256(encoded).hexdigest()


def verify(app):
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(app))


def signature(path):
    """Read the identity fields needed for exchanging full bundles."""
    result = subprocess.run(("/usr/bin/codesign", "-d", "--verbose=4", str(path)),
                            capture_output=True, text=True, check=True, timeout=10)
    fields = dict(line.split("=", 1) for line in result.stderr.splitlines() if "=" in line)
    return {"cdhash": fields["CDHash"], "team": fields.get("TeamIdentifier", "not set")}


def verify_launch_compatibility(app):
    """Do not install a bundle whose directly linked protected libraries have a different signing team."""
    team = signature(app)["team"]
    library_teams = {signature(app / path)["team"] for path in DIRECT_LIBRARIES}
    if team == "not set" or library_teams != {team}:
        raise RuntimeError("library validation: bundle and directly linked libraries require one signing team")


def verify_closed(app):
    running = run("/bin/ps", "-axo", "comm=", timeout=10).splitlines()
    if any(process.strip().startswith(str(app / "Contents") + "/") for process in running):
        raise RuntimeError("Codex still has running processes; the bundle was not exchanged")


def stage(app, state):
    meta = plistlib.loads((app / PLIST).read_bytes())
    if (meta["CFBundleShortVersionString"], meta["CFBundleVersion"], meta["CFBundleIdentifier"]) != (VERSION, BUILD, "com.openai.codex"):
        raise ValueError("unsupported Codex version or build")
    verify(app)
    original_hash = digest(app / ARCHIVE)
    changes = modifications(app / ARCHIVE)
    state.mkdir(mode=0o700)
    for member, contents in changes.items():
        syntax = state / ("check.mjs" if member == VIEW else "check.cjs")
        syntax.write_bytes(contents)
        run("node", "--check", str(syntax), timeout=10)
        syntax.unlink()
    staged = state / app.name
    run("/usr/bin/ditto", str(app), str(staged))
    # Finder metadata on the clone is rejected by codesign. Security attributes stay intact.
    run("/usr/bin/xattr", "-dr", "com.apple.FinderInfo", str(staged))
    output = state / "patched.asar"
    header_hash = pack(app / ARCHIVE, output, changes)
    os.replace(output, staged / ARCHIVE)
    meta["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = header_hash
    (staged / PLIST).write_bytes(plistlib.dumps(meta, fmt=plistlib.FMT_BINARY))
    run("/usr/bin/codesign", "--force", "--sign", "-", "--preserve-metadata=entitlements,requirements,flags,runtime", str(staged))
    verify(staged)
    if digest(app / ARCHIVE) != original_hash:
        raise ValueError("the installed archive changed during staging")
    record = {"app": str(app), "patch": PATCH, "version": VERSION, "build": BUILD, "original": original_hash,
              "patched": digest(staged / ARCHIVE), "files": list(changes),
              "original_signature": signature(app), "patched_signature": signature(staged)}
    (state / "receipt.json").write_text(json.dumps(record, indent=2) + "\n")


def swap(first, second):
    """Exchange verified bundles in one macOS rename; no partially replaced active bundle."""
    libc = ctypes.CDLL(None, use_errno=True)
    function = libc.renamex_np
    function.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
    function.restype = ctypes.c_int
    rename_swap = 0x00000002
    if function(os.fsencode(first), os.fsencode(second), rename_swap):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def read_status(app, state):
    record = json.loads((state / "receipt.json").read_text())
    if record["app"] != str(app):
        raise ValueError("receipt belongs to another app")
    current = digest(app / ARCHIVE)
    staged = state / app.name
    other = digest(staged / ARCHIVE)
    pair = (record["original"], record["patched"])
    current_codes = (signature(app), signature(staged))
    recorded_codes = (record["original_signature"], record["patched_signature"])
    if (current, other) == pair and current_codes == recorded_codes:
        status = "staged"
    elif (other, current) == pair and current_codes == recorded_codes[::-1]:
        status = "installed"
    else:
        raise ValueError("bundle changed since preparation; no swap performed")
    return {"status": status, **record}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("stage", "apply", "restore", "status"))
    parser.add_argument("--app", type=Path, default=Path("/Applications/ChatGPT.app"))
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    app, state = args.app.resolve(), args.state.resolve()
    if args.action == "stage":
        stage(app, state)
    status = read_status(app, state)
    if args.action in ("apply", "restore"):
        expected = "staged" if args.action == "apply" else "installed"
        if status["status"] != expected:
            raise ValueError(f"expected {expected}")
        other = state / app.name
        verify(app)
        verify(other)
        if args.action == "apply":
            verify_launch_compatibility(other)
        verify_closed(app)
        swap(app, other)
        try:
            verify(app)
            status = read_status(app, state)
        except BaseException:
            swap(app, other)
            raise
    print(json.dumps(status))


if __name__ == "__main__":
    main()
