"""aliases.py — 口语归一表。

单独成文件的原因：
  main.py 依赖 astrbot 框架，导入即触发一堆副作用，无法在 CI 里单测。
  把纯数据的映射表拆出来，就能直接用 pytest / unittest 验证，
  也能在 Node 侧对同一套规则做交叉检查。

设计原则：
  1. 只把「明确同义」的说法归到内置项目，不做宽泛猜测。
     例如「腿」「撸铁」都指力量训练；但「打球」不属于任何内置项，
     保留原词让用户当作自定义项目，避免把数据偷偷改写。
  2. 键必须已经过 clean_tag（去空白、≤12 字）。
"""

from __future__ import annotations

# 口语项目名 -> App 内置项目名
# 内置项目：跑步机 / 力量训练 / 拉伸 / 团操 / 动感单车 / 游泳
ITEM_ALIASES = {
    # 力量
    "腿": "力量训练",
    "练腿": "力量训练",
    "腿部": "力量训练",
    "臀": "力量训练",
    "臀腿": "力量训练",
    "胸": "力量训练",
    "背": "力量训练",
    "肩": "力量训练",
    "手臂": "力量训练",
    "核心": "力量训练",
    "撸铁": "力量训练",
    "举铁": "力量训练",
    "力量": "力量训练",
    "无氧": "力量训练",
    "深蹲": "力量训练",
    "硬拉": "力量训练",
    "卧推": "力量训练",
    "引体": "力量训练",
    "哑铃": "力量训练",
    "杠铃": "力量训练",
    # 有氧 / 跑步机
    "跑": "跑步机",
    "跑步": "跑步机",
    "慢跑": "跑步机",
    "快走": "跑步机",
    "有氧": "跑步机",
    "爬坡": "跑步机",
    "爬楼": "跑步机",
    "椭圆机": "跑步机",
    # 拉伸
    "拉伸": "拉伸",
    "放松": "拉伸",
    "筋膜": "拉伸",
    "瑜伽": "拉伸",
    "泡沫轴": "拉伸",
    "开肩": "拉伸",
    # 团操
    "操": "团操",
    "跳操": "团操",
    "团课": "团操",
    "团操": "团操",
    "舞蹈": "团操",
    "跳绳": "团操",
    "HIIT": "团操",
    "hiit": "团操",
    # 单车
    "单车": "动感单车",
    "骑车": "动感单车",
    "骑行": "动感单车",
    "动感单车": "动感单车",
    # 游泳
    "泳": "游泳",
    "游泳": "游泳",
}

# 辛苦程度归一：中文 / 英文 / 常见口误都收
EFFORT_ALIASES = {
    "轻松": "easy",
    "easy": "easy",
    "不累": "easy",
    "适中": "normal",
    "normal": "normal",
    "一般": "normal",
    "还行": "normal",
    "吃力": "hard",
    "hard": "hard",
    "累": "hard",
    "挺累": "hard",
    "有点累": "hard",
    "脱力": "drained",
    "drained": "drained",
    "很累": "drained",
    "力竭": "maxed",
    "maxed": "maxed",
    "极限": "maxed",
    "练废了": "maxed",
}

BUILTIN_ITEMS = ["跑步机", "力量训练", "拉伸", "团操", "动感单车", "游泳"]
VALID_EFFORTS = ["easy", "normal", "hard", "drained", "maxed"]


def canonical_item(raw: str, cleaner) -> str:
    """把口语项目名归一到内置项目。

    cleaner 传入 cleanTag 实现，保持与前端一致的清洗规则。
    认不出的词原样返回，让它成为用户的自定义项目。
    """
    name = cleaner(raw)
    if not name:
        return ""
    return ITEM_ALIASES.get(name, name)


def canonical_effort(raw) -> str | None:
    """把口语强度归一到 id；认不出返回 None，交给调用方保持默认。"""
    if not raw:
        return None
    text = str(raw).strip()
    return EFFORT_ALIASES.get(text) or EFFORT_ALIASES.get(text.lower())


def missing_aliases() -> list[str]:
    """自检：确保映射目标都是合法内置项目，避免打错字。"""
    bad = []
    for key, value in ITEM_ALIASES.items():
        if value not in BUILTIN_ITEMS:
            bad.append(f"{key} -> {value}")
    return bad


def missing_efforts() -> list[str]:
    bad = []
    for key, value in EFFORT_ALIASES.items():
        if value not in VALID_EFFORTS:
            bad.append(f"{key} -> {value}")
    return bad
