#!/usr/bin/env python3
"""ZCode 扩展 · 统计（zcode-ext-stats）：非官方会话统计扩展。

python zcode_ext_stats.py [安装目录] [--tps-footer] [--check | --revert]
默认安装统计补丁，保留 --tps-footer 以兼容已有命令。
安装前完全退出 ZCode；成功后自动启动，检查和还原不启动。
"""

import argparse
import base64
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

def _norm(s: str) -> str:
    return s.lower().replace(" ", "").replace("-", "")


def _from_running_processes(found: list[Path]) -> None:
    """1) 正在运行的 ZCode 进程路径（最准：用户实际在用哪个）"""
    if os.name != "nt":
        return
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-Process | Where-Object {$_.Path} | "
             "Select-Object -ExpandProperty Path -Unique"],
            capture_output=True, timeout=15, errors="replace",
        ).stdout or b""
    except Exception:
        return
    for line in out.decode(errors="replace").splitlines():
        line = line.strip()
        # ZCode.exe / ZCode Skin Manager 等都指向安装根目录
        if line.lower().endswith(".exe") and "zcode" in _norm(Path(line).name):
            found.append(Path(line).parent)


def _from_registry(found: list[Path]) -> None:
    """2) 注册表卸载信息里的 InstallLocation / DisplayIcon"""
    if os.name != "nt":
        return
    try:
        import winreg
    except ImportError:
        return
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for sub in (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                    r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"):
            try:
                base = winreg.OpenKey(hive, sub)
            except OSError:
                continue
            with base:
                for i in range(winreg.QueryInfoKey(base)[0]):
                    try:
                        with winreg.OpenKey(base, winreg.EnumKey(base, i)) as k:
                            try:
                                name = winreg.QueryValueEx(k, "DisplayName")[0]
                            except OSError:
                                continue
                            if "zcode" not in _norm(str(name)):
                                continue
                            for val in ("InstallLocation", "DisplayIcon", "UninstallString"):
                                try:
                                    v = str(winreg.QueryValueEx(k, val)[0])
                                except OSError:
                                    continue
                                p = Path(v.strip('"').split(",")[0].strip())
                                found.append(p if p.is_dir() else p.parent)
                                break
                    except OSError:
                        continue


def _from_common_dirs(found: list[Path]) -> None:
    """3) 常规安装目录：Windows Program Files 系 / macOS /Applications / Linux /opt、/usr/share"""
    bases = [os.environ.get("ProgramFiles"),
             os.environ.get("ProgramFiles(x86)"),
             os.environ.get("ProgramW6432"),
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"),
             "/Applications",
             os.path.expanduser("~/Applications"),
             "/opt",
             "/usr/share"]
    for base in bases:
        if not base or not Path(base).is_dir():
            continue
        try:
            for entry in os.scandir(base):
                if not entry.is_dir() or "zcode" not in _norm(entry.name):
                    continue
                if entry.name.endswith(".app"):
                    found.append(Path(entry.path) / "Contents")   # macOS .app 包，资源在 Contents 下
                else:
                    found.append(Path(entry.path))
        except OSError:
            continue


def discover() -> list[Path]:
    """返回所有探测到的 app.asar（去重、保序）"""
    roots: list[Path] = []
    for probe in (_from_running_processes, _from_registry, _from_common_dirs):
        try:
            probe(roots)
        except Exception:
            pass
    seen, result = set(), []
    for root in roots:
        asar = root / "resources" / "app.asar"
        try:
            key = asar.resolve()
        except OSError:
            key = asar
        if asar.is_file() and key not in seen:
            seen.add(key)
            result.append(asar)
    return result


def resolve_target(arg: str | None) -> list[Path]:
    if not arg:
        return discover()
    p = Path(arg)
    # 支持安装根目录、macOS .app 包和 app.asar 文件
    if p.is_file() and p.name == "app.asar":
        return [p]
    roots = [p, p / "Contents"] if p.name.lower().endswith(".app") else [p]
    for root in roots:
        asar = root / "resources" / "app.asar"
        if asar.is_file():
            return [asar]
    raise SystemExit(f"[!] 指定路径下找不到 app.asar：{arg}")


# Keep packaged paths and hook markers stable for updates/removal of installed versions.
TPS_INDEX_PATH = "out/renderer/index.html"
TPS_SCRIPT_PATH = "out/renderer/zcode-tps.js"
TPS_TAG = f'<script src="./{TPS_SCRIPT_PATH.split("/")[-1]}"></script>'
TPS_MAIN_PATH = "out/main/index.js"
TPS_PRELOAD_PATH = "out/preload/index.cjs"
TPS_BACKEND_PATH = "out/main/zcode-tps-main.cjs"
TPS_MAIN_BLOCK = (
    '\n/* zcode-tps-v2:begin */\n'
    'import __zcodeTpsStats from "./zcode-tps-main.cjs";\n'
    'try { __zcodeTpsStats.install(); } catch (e) { console.warn("ZCode statistics unavailable"); }\n'
    '/* zcode-tps-v2:end */\n'
).encode()
TPS_PRELOAD_BLOCK = (
    '\n/* zcode-tps-v2:begin */\n'
    '(() => { try { const { contextBridge, ipcRenderer } = require("electron");\n'
    'contextBridge.exposeInMainWorld("zcodeSessionStats", {\n'
    'read: (sessionId) => ipcRenderer.invoke("zcode-patcher:session-stats:v2", sessionId)\n'
    '}); } catch (e) { console.warn("ZCode statistics bridge unavailable"); } })();\n'
    '/* zcode-tps-v2:end */\n'
).encode()


def _tps_unhook(data: bytes, block: bytes) -> bytes:
    """Only remove our exact hook; refuse damaged or unfamiliar hook versions."""
    count = data.count(b"/* zcode-tps-v2:begin */")
    if count != data.count(b"/* zcode-tps-v2:end */") or count > 1:
        raise ValueError("TPS hook 标记不完整或不唯一，拒绝修改")
    if count and data.count(block) != 1:
        raise ValueError("TPS hook 内容与当前版本不匹配，拒绝修改")
    return data.replace(block, b"")


def _asar_header_raw(asar: Path):
    """读整个 asar：返回 (原始全量 bytes, header 树, 数据区起始偏移)。"""
    raw = asar.read_bytes()
    if len(raw) < 16:
        raise ValueError(f"asar 文件过小: {asar}")
    f0, f1, f2, f3 = struct.unpack("<4I", raw[:16])
    if f0 != 4:
        raise ValueError(f"asar 头格式不符（首 uint32={f0}，期望 4）: {asar}")
    header = json.loads(raw[16:16 + f3].decode("utf-8"))
    return raw, header, 8 + f1


def _asar_entry_bytes(raw: bytes, data_start: int, ent: dict) -> bytes:
    off = data_start + int(ent["offset"])
    return raw[off:off + ent["size"]]


def _asar_integrity(data: bytes, block_size: int = 4194304) -> dict:
    blocks = [hashlib.sha256(data[i:i + block_size]).hexdigest()
              for i in range(0, len(data), block_size)]
    return {"algorithm": "SHA256", "hash": hashlib.sha256(data).hexdigest(),
            "blockSize": block_size, "blocks": blocks}


def _asar_walk_entries(node, path=""):
    """yield (全路径, 叶子条目 dict)。目录与 unpacked 条目不产出。"""
    for name, ent in (node.get("files") or {}).items():
        p = f"{path}/{name}" if path else name
        if "files" in ent:
            yield from _asar_walk_entries(ent, p)
        elif not ent.get("unpacked"):
            yield p, ent


def _repack_asar(asar: Path, overwrite: dict[str, bytes], remove: set[str]) -> int:
    """通用 asar 重打包：树中删除 remove 条目，overwrite 覆盖/新增文件数据并重算 integrity，
    全部条目 offset 重排；写临时文件、回读校验后原子替换。返回新文件大小。"""
    raw, header, data_start = _asar_header_raw(asar)

    # overwrite 中树里尚不存在的路径（新增文件）按层级插入占位条目
    for p in overwrite:
        parts = p.split("/")
        node = header
        for part in parts[:-1]:
            node = node.setdefault("files", {}).setdefault(part, {"files": {}})
        leaf = node.setdefault("files", {})
        leaf.setdefault(parts[-1], {"size": 0, "offset": "0"})

    def purge(node, prefix):
        files = node.get("files") or {}
        for name in list(files.keys()):
            ent = files[name]
            p = f"{prefix}/{name}" if prefix else name
            if "files" in ent:
                purge(ent, p)
                if not ent["files"]:
                    del files[name]          # 删空的目录一并移除
            elif p in remove:
                del files[name]

    purge(header, "")
    # relayout 会改写 ent.offset，旧数据位置必须先快照（emit 二次读数据时用）
    old_positions = {p: (int(ent["offset"]), ent["size"]) for p, ent in _asar_walk_entries(header)}
    cursor = 0

    def entry_data(p: str, ent: dict) -> bytes:
        data = overwrite.get(p)
        if data is None:
            off, size = old_positions[p]
            data = raw[data_start + off:data_start + off + size]
        return data

    def relayout(node, prefix):
        nonlocal cursor
        for name, ent in (node.get("files") or {}).items():
            p = f"{prefix}/{name}" if prefix else name
            if "files" in ent:
                relayout(ent, p)
            elif ent.get("unpacked"):
                continue
            else:
                data = entry_data(p, ent)
                ent["size"] = len(data)
                ent["offset"] = str(cursor)
                if p in overwrite:
                    ent["integrity"] = _asar_integrity(data)
                cursor += len(data)

    relayout(header, "")
    json_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pad = (4 - len(json_bytes) % 4) % 4
    header_blob = (struct.pack("<4I", 4, 8 + len(json_bytes) + pad, 4 + len(json_bytes) + pad, len(json_bytes))
                   + json_bytes + b"\x00" * pad)

    tmp = asar.with_name(asar.name + ".tps-tmp")
    with open(tmp, "wb") as out:
        out.write(header_blob)

        def emit(node, prefix):
            for name, ent in (node.get("files") or {}).items():
                p = f"{prefix}/{name}" if prefix else name
                if "files" in ent:
                    emit(ent, p)
                elif ent.get("unpacked"):
                    continue
                else:
                    out.write(entry_data(p, ent))

        emit(header, "")

    v_raw, v_header, v_start = _asar_header_raw(tmp)
    v_files = dict(_asar_walk_entries(v_header))
    try:
        for p, want in overwrite.items():
            ent = v_files.get(p)
            if ent is None or _asar_entry_bytes(v_raw, v_start, ent) != want:
                raise ValueError(f"重打包校验失败: {p}")
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, asar)
    return asar.stat().st_size


def process_tps_footer(asar: Path, check_only: bool, revert: bool, tps_src: Path | None) -> None:
    side = asar.with_name(asar.name + ".tps-patch.json")
    bak = asar.with_name(asar.name + ".tps.bak")
    raw, header, data_start = _asar_header_raw(asar)
    paths = dict(_asar_walk_entries(header))
    required = (TPS_INDEX_PATH, TPS_MAIN_PATH, TPS_PRELOAD_PATH)
    missing = [p for p in required if p not in paths]
    if missing:
        raise ValueError(f"客户端结构不兼容，缺少 {', '.join(missing)}")
    contents = {p: _asar_entry_bytes(raw, data_start, paths[p]) for p in required}
    idx = contents[TPS_INDEX_PATH]
    if idx.count(TPS_TAG.encode()) > 1:
        raise ValueError("TPS script 标签不唯一，拒绝修改")
    main = _tps_unhook(contents[TPS_MAIN_PATH], TPS_MAIN_BLOCK)
    preload = _tps_unhook(contents[TPS_PRELOAD_PATH], TPS_PRELOAD_BLOCK)
    tagged = TPS_TAG.encode() in idx
    installed = (tagged and TPS_SCRIPT_PATH in paths and TPS_BACKEND_PATH in paths
                 and TPS_MAIN_BLOCK in contents[TPS_MAIN_PATH]
                 and TPS_PRELOAD_BLOCK in contents[TPS_PRELOAD_PATH])
    legacy = tagged and TPS_SCRIPT_PATH in paths and not installed
    if check_only:
        state = "v2 已打" if installed else ("旧版/不完整，重新执行可升级" if legacy else "未打/不完整")
        print(f"[*] {asar}\n    会话统计: {state} | 备份: {'有' if bak.is_file() else '无'}")
        return
    clean_idx = idx.replace(TPS_TAG.encode(), b"")
    if revert:
        if (not tagged and TPS_BACKEND_PATH not in paths and TPS_SCRIPT_PATH not in paths
                and main == contents[TPS_MAIN_PATH] and preload == contents[TPS_PRELOAD_PATH]):
            print(f"[.] {asar}\n    未打 TPS 注入，跳过")
            return
        _repack_asar(asar, {TPS_INDEX_PATH: clean_idx, TPS_MAIN_PATH: main,
                           TPS_PRELOAD_PATH: preload}, {TPS_SCRIPT_PATH, TPS_BACKEND_PATH})
        side.unlink(missing_ok=True)
        bak.unlink(missing_ok=True)
        print(f"[+] {asar}\n    已移除会话统计脚本及主进程/preload hook，备份已清理")
        return
    if clean_idx.count(b"</body>") != 1:
        raise ValueError("index.html 的 </body> 不唯一，拒绝修改")
    source_dir = Path(__file__).resolve().parent
    source = tps_src or source_dir / "zcode-ext-stats.js"
    backend = source_dir / "zcode-ext-stats-main.cjs"
    if not source.is_file() or not backend.is_file():
        raise ValueError(f"缺少统计脚本：{source} 或 {backend}")
    overwrite = {
        TPS_INDEX_PATH: clean_idx.replace(b"</body>", TPS_TAG.encode() + b"</body>", 1),
        TPS_MAIN_PATH: main + TPS_MAIN_BLOCK,
        TPS_PRELOAD_PATH: preload + TPS_PRELOAD_BLOCK,
        TPS_SCRIPT_PATH: source.read_bytes(),
        TPS_BACKEND_PATH: backend.read_bytes(),
    }
    if installed and all(p in paths and _asar_entry_bytes(raw, data_start, paths[p]) == want
                         for p, want in overwrite.items()):
        print(f"[=] {asar}\n    会话统计 v2 已是当前版本，跳过")
        return
    if not bak.is_file():
        shutil.copyfile(asar, bak)
    # Persist recovery metadata before touching the archive.
    side.write_text(json.dumps({
        "version": 2, "asar_size": len(raw),
        "index_original_b64": base64.b64encode(clean_idx).decode(),
        "originals": {p: base64.b64encode(v).decode() for p, v in
                      {TPS_INDEX_PATH: clean_idx, TPS_MAIN_PATH: main, TPS_PRELOAD_PATH: preload}.items()},
    }, ensure_ascii=False), encoding="utf-8")
    new_size = _repack_asar(asar, overwrite, set())
    record = json.loads(side.read_text(encoding="utf-8"))
    record["asar_size"] = new_size
    side.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    print(f"[+] {asar}\n    会话统计 v2 注入/更新完成（历史用量只读查询 + 双入口详情卡片）\n"
          f"    原件备份: {bak.name} | 记录: {side.name}")


def _resolve_asars(target: str | None) -> list[Path]:
    asars = list(dict.fromkeys(resolve_target(target)))
    if not asars:
        raise SystemExit("[!] 未找到 app.asar；请指定 ZCode 安装目录")
    return asars


def launch_zcode(asar: Path) -> None:
    """Start the patched installation without terminating any existing process."""
    root = asar.parent.parent
    candidates = ([root / "ZCode.exe"] if sys.platform == "win32" else
                  [root / "MacOS" / "ZCode"] if sys.platform == "darwin" else
                  [root / "zcode", root / "ZCode"])
    executable = next((path for path in candidates if path.is_file()), None)
    if executable is None:
        print(f"[!] 补丁已完成，但未找到启动程序：{root}；请手动启动 ZCode")
        return
    try:
        subprocess.Popen([str(executable)], cwd=str(executable.parent),
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        print(f"[+] 已发起 ZCode 启动：{executable}")
    except OSError as exc:
        print(f"[!] 补丁已完成，但自动启动失败：{exc}；请手动启动 ZCode")


def main() -> None:
    ap = argparse.ArgumentParser(description="ZCode 扩展 · 统计（zcode-ext-stats）：非官方会话统计扩展，支持实时 TPS、Token 与缓存用量")
    ap.add_argument("target", nargs="?", help="安装根目录或 app.asar 路径；缺省自动探测")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="只检查状态，不修改或启动客户端")
    mode.add_argument("--revert", action="store_true", help="移除会话统计补丁，不启动客户端")
    ap.add_argument("--tps-footer", action="store_true", help="安装会话统计补丁（默认行为，兼容原命令）")
    ap.add_argument("--tps-src", default=None, help="指定渲染脚本路径")
    args = ap.parse_args()
    asars = _resolve_asars(args.target)
    label = "检查" if args.check else ("还原" if args.revert else "打补丁")
    print(f"=== 会话统计补丁，目标 {len(asars)} 处，模式：{label} ===")
    failed = False
    for asar in asars:
        try:
            process_tps_footer(asar, args.check, args.revert,
                               Path(args.tps_src) if args.tps_src else None)
        except PermissionError:
            failed = True
            print(f"[!] {asar}\n    文件被占用或无写入权限；完全退出 ZCode 后重试")
    if failed:
        raise SystemExit(1)
    if not args.check and not args.revert:
        for asar in asars:
            launch_zcode(asar)
        print("=== 提示：升级后需重新执行补丁 ===")


if __name__ == "__main__":
    main()
