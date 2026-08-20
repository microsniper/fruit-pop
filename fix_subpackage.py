#!/usr/bin/env python3
"""
微信小游戏构建后处理脚本
将 bundle_late 正确注册为 subpackage，同步 game.json 和 settings.json

Cocos 3.8.8 构建时会自动将 isBundle:true 的目录写入 game.json 的 subpackages，
但 settings.json 中 subpackages 为空，两边不一致导致：
  - 微信锁住 assets/bundle_late/ 目录
  - Cocos 引擎 require('assets/bundle_late/index.js') 失败
  - 所有分包图片不显示

修复方案：
  1. settings.json 中将 bundle_late 加入 subpackages 列表
  2. game.json 中注册 bundle_late 为 subpackage（root 指向 subpackages/bundle_late/）
  3. 将 assets/bundle_late/ 移动到 subpackages/bundle_late/
  4. 创建 subpackages/bundle_late/game.js 入口文件
  5. 在 game.js 开头注入版本更新检查（微信 UpdateManager，仅正式版生效）
     下载完成只挂 globalThis.__wxPendingUpdate 标记，不打断对局；
     重启提示由 HomePage.render() 在玩家回到首页时弹出。

使用方法：
  python3 fix_subpackage.py
"""

import json
import os
import shutil
import sys

BUILD_DIR = os.path.join(os.path.dirname(__file__), "build", "wechatgame")
GAME_JSON = os.path.join(BUILD_DIR, "game.json")
SETTINGS_JSON = os.path.join(BUILD_DIR, "src", "settings.json")
BUNDLE_NAME = "bundle_late"
SRC_BUNDLE_DIR = os.path.join(BUILD_DIR, "assets", BUNDLE_NAME)
DEST_BUNDLE_DIR = os.path.join(BUILD_DIR, "subpackages", BUNDLE_NAME)
GAME_JS = os.path.join(DEST_BUNDLE_DIR, "game.js")


GAME_JS_PATH = os.path.join(BUILD_DIR, "game.js")

# 注入到 game.js 开头的版本更新检查代码
# 机制说明：微信冷启动时异步下载新包，本次仍运行旧版；onUpdateReady 在新包
# 下载完成时触发——此时玩家可能正在游戏中，直接弹窗重启会打断对局甚至丢进度，
# 所以这里只把 updateManager 挂到 globalThis 做标记，不做任何提示；
# 真正的「重启提示 + applyUpdate」延后到 HomePage.render()（玩家回到首页的安全时机）。
# 注意：wx.getUpdateManager 仅正式版生效，开发版/体验版不触发回调。
MARKER_START = "// ===== 版本更新检查"
MARKER_END = "// ===== 版本更新检查结束 ====="
UPDATE_CHECK_JS = """\
// ===== 版本更新检查：由 fix_subpackage.py 注入，勿手动修改 =====
(function () {
    if (typeof wx === 'undefined' || !wx.getUpdateManager) { return; }
    var updateManager = wx.getUpdateManager();
    // 新包下载完成：只挂标记，绝不在这里弹窗（玩家可能正在对局中）。
    // 消费方：HomePage.render() —— 所有「返回首页」路径的唯一漏斗。
    updateManager.onUpdateReady(function () {
        globalThis.__wxPendingUpdate = updateManager;
    });
    updateManager.onUpdateFailed(function () {
        console.warn('[update] 新版本下载失败，将在下次冷启动时重试');
    });
})();
// ===== 版本更新检查结束 =====
"""


def _strip_existing_block(content):
    """摘掉 game.js 里已有的注入块，返回 (剩余内容, 是否摘到)。

    新格式有起止标记，直接按标记切；旧格式（只有起始标记、无结束标记）是单个
    IIFE，切到其后第一个 "})();" 为止——这样老 build 重跑脚本也能替换成新逻辑，
    不会因为「文件里已有 getUpdateManager」就跳过、把旧的强更弹窗留在包里。
    """
    start = content.find(MARKER_START)
    if start == -1:
        return content, False

    end_pos = content.find(MARKER_END, start)
    if end_pos != -1:
        cut_end = end_pos + len(MARKER_END)
    else:
        iife_end = content.find("})();", start)
        if iife_end == -1:
            return content, False
        cut_end = iife_end + len("})();")

    while cut_end < len(content) and content[cut_end] in "\r\n":
        cut_end += 1
    return content[:start] + content[cut_end:], True


def inject_update_manager():
    """在 wechatgame 的 game.js 开头注入版本更新检查（幂等；已有旧版本会被替换）"""
    if not os.path.exists(GAME_JS_PATH):
        print(f"[ERROR] 找不到 game.js: {GAME_JS_PATH}")
        sys.exit(1)

    with open(GAME_JS_PATH, "r", encoding="utf-8") as f:
        original = f.read()

    stripped, had_block = _strip_existing_block(original)
    updated = UPDATE_CHECK_JS + "\n" + stripped

    if updated == original:
        print(f"[OK] game.js 版本更新检查已是最新，跳过注入")
        return

    with open(GAME_JS_PATH, "w", encoding="utf-8") as f:
        f.write(updated)

    action = "已替换为最新版" if had_block else "已注入"
    print(f"[FIXED] game.js 版本更新检查{action}（只挂标记，回首页时才提示重启）")


def fix_settings_json():
    """settings.json 中将 bundle_late 加入 subpackages 列表"""
    if not os.path.exists(SETTINGS_JSON):
        print(f"[ERROR] 找不到 settings.json: {SETTINGS_JSON}")
        sys.exit(1)

    with open(SETTINGS_JSON, "r", encoding="utf-8") as f:
        settings = json.load(f)

    subpackages = settings.get("assets", {}).get("subpackages", [])

    if BUNDLE_NAME in subpackages:
        print(f"[OK] settings.json 中 bundle_late 已在 subpackages 列表")
        return

    subpackages.append(BUNDLE_NAME)
    settings["assets"]["subpackages"] = subpackages

    with open(SETTINGS_JSON, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)

    print(f"[FIXED] settings.json 已将 bundle_late 加入 subpackages")
    print(f"  当前 subpackages: {subpackages}")


def fix_game_json():
    """game.json 中注册 bundle_late 为 subpackage"""
    if not os.path.exists(GAME_JSON):
        print(f"[ERROR] 找不到 game.json: {GAME_JSON}")
        sys.exit(1)

    with open(GAME_JSON, "r", encoding="utf-8") as f:
        config = json.load(f)

    subpackages = config.get("subpackages", [])

    # 移除旧的 bundle_late 配置（如果有）
    subpackages = [pkg for pkg in subpackages if pkg.get("name") != BUNDLE_NAME]

    # 添加正确的 bundle_late 配置
    subpackages.append({"name": BUNDLE_NAME, "root": f"subpackages/{BUNDLE_NAME}/"})
    config["subpackages"] = subpackages

    with open(GAME_JSON, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=4, ensure_ascii=False)

    print(f"[FIXED] game.json 已注册 bundle_late 分包")
    print(f"  root: subpackages/{BUNDLE_NAME}/")


def move_bundle_dir():
    """将 assets/bundle_late/ 移动到 subpackages/bundle_late/"""
    if not os.path.exists(SRC_BUNDLE_DIR):
        print(f"[ERROR] 找不到源目录: {SRC_BUNDLE_DIR}")
        sys.exit(1)

    # 如果目标已存在，先删除（避免旧文件残留）
    if os.path.exists(DEST_BUNDLE_DIR):
        shutil.rmtree(DEST_BUNDLE_DIR)

    # 创建 subpackages 目录
    os.makedirs(os.path.dirname(DEST_BUNDLE_DIR), exist_ok=True)

    # 移动目录
    shutil.move(SRC_BUNDLE_DIR, DEST_BUNDLE_DIR)
    print(f"[FIXED] 已移动 assets/{BUNDLE_NAME}/ -> subpackages/{BUNDLE_NAME}/")


def create_game_js():
    """创建 subpackage 入口文件 game.js（微信要求）"""
    with open(GAME_JS, "w", encoding="utf-8") as f:
        f.write("// bundle_late subpackage entry (required by WeChat MiniGame)\n")
    print(f"[FIXED] 已创建 game.js 入口文件")


if __name__ == "__main__":
    fix_settings_json()
    fix_game_json()
    move_bundle_dir()
    create_game_js()
    inject_update_manager()
    print("\n[DONE] 分包修复完成，可以预览/上传了")
