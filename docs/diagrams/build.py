"""从共享图源生成离线 HTML、独立 SVG 与 Mermaid 阅读文档。仅使用 Python 标准库。"""

from __future__ import annotations

import html
import json
import math
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent
GRAPH_IDS = (
    "overview", "architecture", "analysis", "model", "scenario",
    "navigation", "incremental", "rules",
)
PALETTE = {
    "core": ("#eef4ff", "#6082b2", "#31577e"),
    "data": ("#f0f3f8", "#8a9aaf", "#475b73"),
    "business": ("#eaf7f4", "#60a99b", "#24796d"),
    "optional": ("#f4effb", "#ac93c5", "#80619f"),
    "warning": ("#fff6e8", "#d6ab6a", "#a87931"),
}


def escape(value: object) -> str:
    return html.escape(str(value), quote=True)


def text_width(value: str, size: float) -> float:
    return sum(0.56 if ord(c) < 128 else 1.0 for c in value) * size


def wrap(value: str, max_width: float, size: float) -> list[str]:
    result = []
    for paragraph in value.split("\n"):
        line = ""
        for char in paragraph:
            if line and text_width(line + char, size) > max_width:
                result.append(line)
                line = char
            else:
                line += char
        result.append(line)
    return result


def svg_text(x: float, y: float, value: str, size: float = 19,
             width: float = 190, fill: str = "#243b53", weight: int = 500,
             centered: bool = True) -> str:
    lines = wrap(value, width, size)
    line_height = size * 1.35
    top = y - (len(lines) - 1) * line_height / 2
    anchor = "middle" if centered else "start"
    content = "".join(
        f'<tspan x="{x:g}" y="{top + index * line_height:g}">{escape(line)}</tspan>'
        for index, line in enumerate(lines)
    )
    return (
        f'<text text-anchor="{anchor}" dominant-baseline="central" '
        f'font-size="{size:g}" font-weight="{weight}" fill="{fill}">{content}</text>'
    )


def centers(node: dict) -> tuple[float, float]:
    return node["x"] + node["w"] / 2, node["y"] + node["h"] / 2


def route(edge: dict, nodes: dict) -> list[tuple[float, float]]:
    if edge.get("points"):
        return [tuple(point) for point in edge["points"]]
    start, end = nodes[edge["from"]], nodes[edge["to"]]
    sx, sy = centers(start)
    tx, ty = centers(end)
    dx, dy = tx - sx, ty - sy
    if abs(dx) / max(start["w"], 1) >= abs(dy) / max(start["h"], 1):
        ax = start["x"] + (start["w"] if dx >= 0 else 0)
        bx = end["x"] + (0 if dx >= 0 else end["w"])
        middle = (ax + bx) / 2
        return [(ax, sy), (middle, sy), (middle, ty), (bx, ty)]
    ay = start["y"] + (start["h"] if dy >= 0 else 0)
    by = end["y"] + (0 if dy >= 0 else end["h"])
    middle = (ay + by) / 2
    return [(sx, ay), (sx, middle), (tx, middle), (tx, by)]


def label_position(points: list[tuple[float, float]]) -> tuple[float, float]:
    segments = list(zip(points, points[1:]))
    first, second = max(segments, key=lambda pair: math.dist(*pair))
    return (first[0] + second[0]) / 2, (first[1] + second[1]) / 2


def overlaps(first: tuple, second: tuple, padding: float = 0) -> bool:
    return (min(first[2], second[2]) + padding > max(first[0], second[0])
            and min(first[3], second[3]) + padding > max(first[1], second[1]))


def layout_labels(graph: dict) -> dict[int, tuple]:
    """保留图源中的优先位置，必要时避让节点、其他标签与画布边界。"""
    occupied = [(node["x"], node["y"], node["x"] + node["w"], node["y"] + node["h"])
                for node in graph["nodes"]]
    occupied += [(group["x"] + 12, group["y"] + 8,
                  group["x"] + group["w"] - 12, group["y"] + 38)
                 for group in graph.get("groups", [])]
    nodes = {node["id"]: node for node in graph["nodes"]}
    result = {}
    for index, edge in enumerate(graph["edges"]):
        if not edge.get("label"):
            continue
        lines = wrap(edge["label"], 140, 14)
        width = max(text_width(line, 14) for line in lines) + 14
        height = len(lines) * 19 + 4
        base_x, base_y = label_position(route(edge, nodes))
        base_x, base_y = edge.get("labelX", base_x), edge.get("labelY", base_y)
        offsets = [(0, 0)]
        for distance in (18, 30, 44, 58, 74, 94, 118, 146, 180, 220):
            offsets += [(0, -distance), (0, distance), (-distance, 0), (distance, 0),
                        (-distance, -distance), (distance, -distance),
                        (-distance, distance), (distance, distance)]
        for dx, dy in offsets:
            x, y = base_x + dx, base_y + dy
            box = (x - width / 2, y - height / 2, x + width / 2, y + height / 2)
            if (box[0] < 12 or box[1] < 42 or box[2] > graph["width"] - 12
                    or box[3] > graph["height"] - 36):
                continue
            if not any(overlaps(box, other, 5) for other in occupied):
                occupied.append(box)
                result[index] = (x, y, width, height, base_x, base_y)
                break
        else:
            raise ValueError(f'{graph["id"]}：无法为连线标签找到可读位置：{edge["label"]}')
    return result


def nearest_on_route(x: float, y: float, points: list[tuple]) -> tuple[float, float]:
    candidates = []
    for start, end in zip(points, points[1:]):
        dx, dy = end[0] - start[0], end[1] - start[1]
        denominator = dx * dx + dy * dy
        ratio = 0 if not denominator else max(0, min(1, ((x - start[0]) * dx + (y - start[1]) * dy) / denominator))
        candidates.append((start[0] + ratio * dx, start[1] + ratio * dy))
    return min(candidates, key=lambda candidate: math.dist(candidate, (x, y)))


def validate(data: dict) -> None:
    graphs = data["graphs"]
    if tuple(graph["id"] for graph in graphs) != GRAPH_IDS:
        raise ValueError("图集必须按约定包含八张图")
    for graph in graphs:
        guide = graph.get("plainGuide", {})
        for field in ("summary", "example", "scope"):
            if not isinstance(guide.get(field), str) or not guide[field].strip():
                raise ValueError(f'{graph["id"]}：缺少通俗说明 {field}')
        reading = guide.get("reading")
        if (not isinstance(reading, list) or not reading
                or any(not isinstance(item, str) or not item.strip() for item in reading)):
            raise ValueError(f'{graph["id"]}：读图方法必须为非空文字列表')
        identifiers = [node["id"] for node in graph["nodes"]]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError(f'{graph["id"]}：节点 ID 重复')
        for node in graph["nodes"]:
            if not re.fullmatch(r"[a-zA-Z0-9_-]+", node["id"]):
                raise ValueError("节点 ID 必须为字母、数字、下划线或短横线")
            if not node.get("detail") or not node.get("label"):
                raise ValueError(f'{graph["id"]}：节点缺少名称或说明')
            if not isinstance(node.get("plainExplanation"), str) or not node["plainExplanation"].strip():
                raise ValueError(f'{graph["id"]}/{node["id"]}：节点缺少通俗解释')
            if node.get("type", "core") not in PALETTE:
                raise ValueError(f'{graph["id"]}：未知节点类型')
            if (node["x"] < 0 or node["y"] < 0
                    or node["x"] + node["w"] > graph["width"]
                    or node["y"] + node["h"] > graph["height"] - 35):
                raise ValueError(f'{graph["id"]}/{node["id"]}：节点超出画布')
            if len(wrap(node["label"], node["w"] - 28, 19)) * 25.65 > node["h"] - 20:
                raise ValueError(f'{graph["id"]}/{node["id"]}：节点文字超出高度')
        for index, node in enumerate(graph["nodes"]):
            for other in graph["nodes"][index + 1:]:
                horizontal = min(node["x"] + node["w"], other["x"] + other["w"]) - max(node["x"], other["x"])
                vertical = min(node["y"] + node["h"], other["y"] + other["h"]) - max(node["y"], other["y"])
                if horizontal > 0 and vertical > 0:
                    raise ValueError(f'{graph["id"]}：节点 {node["id"]} 与 {other["id"]} 重叠')
        for edge in graph["edges"]:
            if edge["from"] not in identifiers or edge["to"] not in identifiers:
                raise ValueError(f'{graph["id"]}：连线引用不存在的节点')
        for source in graph.get("source", []):
            if not (ROOT / source["path"]).resolve().is_file():
                raise ValueError(f'来源文件不存在：{source["path"]}')


def render_svg(graph: dict) -> str:
    graph_id = graph["id"]
    width, height = graph["width"], graph["height"]
    nodes = {node["id"]: node for node in graph["nodes"]}
    output = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" role="img" aria-labelledby="{graph_id}-title {graph_id}-desc">',
        f'<title id="{graph_id}-title">{escape(graph["title"])} · 设计图解</title>',
        f'<desc id="{graph_id}-desc">{escape(graph["plainGuide"]["summary"])} '
        f'{escape(graph["plainGuide"]["scope"])} {escape(graph["description"])}</desc>',
        '<style>text{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif} '
        '.graph-node{cursor:pointer;outline:none}.graph-node:hover rect,.graph-node:focus rect'
        '{stroke-width:3;filter:brightness(.97)} .edge-label{pointer-events:none}</style>',
        '<defs>',
    ]
    for kind, color in (("flow", "#8496ad"), ("dependency", "#8496ad"),
                        ("evidence", "#8c9daa"), ("optional", "#ab8dbe"),
                        ("failure", "#c59550")):
        output.append(
            f'<marker id="{graph_id}-{kind}" viewBox="0 0 10 10" refX="9" refY="5" '
            f'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M 1 1 L 9 5 L 1 9 z" fill="{color}"/></marker>'
        )
    output += ['</defs>', f'<rect width="{width}" height="{height}" fill="#fff"/>']
    for group in graph.get("groups", []):
        output.append(
            f'<rect x="{group["x"]}" y="{group["y"]}" width="{group["w"]}" '
            f'height="{group["h"]}" rx="14" fill="#f7f9fc" stroke="#e2e8f0"/>'
        )
        output.append(svg_text(group["x"] + 18, group["y"] + 24, group["label"],
                               15, group["w"] - 32, "#61758e", 600, False))
    labels = []
    label_layout = layout_labels(graph)
    for edge_index, edge in enumerate(graph["edges"]):
        points = route(edge, nodes)
        kind = edge.get("kind", "flow")
        color = {"failure": "#c59550", "optional": "#ab8dbe", "evidence": "#8c9daa"}.get(kind, "#8496ad")
        dash = ' stroke-dasharray="7 5"' if kind in ("optional", "evidence", "failure") else ""
        coordinates = " ".join(f'{x:g},{y:g}' for x, y in points)
        output.append(
            f'<polyline points="{coordinates}" fill="none" stroke="{color}" stroke-width="1.8" '
            f'stroke-linejoin="round" marker-end="url(#{graph_id}-{kind})"{dash}/>'
        )
        if edge.get("label"):
            label_x, label_y, box_width, box_height, base_x, base_y = label_layout[edge_index]
            leader = ""
            if math.dist((label_x, label_y), (base_x, base_y)) > 10:
                anchor_x, anchor_y = nearest_on_route(base_x, base_y, points)
                leader = (f'<line x1="{anchor_x:g}" y1="{anchor_y:g}" x2="{label_x:g}" y2="{label_y:g}" '
                          f'stroke="#b8c5d4" stroke-width="1" stroke-dasharray="2 3"/>')
            labels.append(
                f'<g class="edge-label">{leader}<rect x="{label_x - box_width / 2:g}" '
                f'y="{label_y - box_height / 2:g}" width="{box_width:g}" height="{box_height:g}" '
                f'rx="4" fill="#fff" fill-opacity=".96"/>'
                + svg_text(label_x, label_y, edge["label"], 14, 140, "#5d728c", 400) + '</g>'
            )
    output.extend(labels)
    for node in graph["nodes"]:
        fill, stroke, accent = PALETTE[node.get("type", "core")]
        dash = ' stroke-dasharray="6 4"' if node.get("type") == "optional" else ""
        cx, cy = centers(node)
        output.append(
            f'<g class="graph-node" data-node-id="{escape(node["id"])}" tabindex="0" '
            f'role="button" aria-label="{escape(node["label"].replace(chr(10), " "))}：'
            f'{escape(node["plainExplanation"])}">'
            f'<title>{escape(node["plainExplanation"])}\n专业说明：{escape(node["detail"])}</title>'
            f'<rect x="{node["x"]}" y="{node["y"]}" width="{node["w"]}" height="{node["h"]}" '
            f'rx="10" fill="{fill}" stroke="{stroke}" stroke-width="1.3"{dash}/>'
            f'<rect x="{node["x"] + 1}" y="{node["y"] + 14}" width="3" '
            f'height="{max(8, node["h"] - 28)}" rx="1.5" fill="{accent}"/>'
            + svg_text(cx, cy, node["label"], 19, node["w"] - 28) + '</g>'
        )
    output.append(svg_text(24, height - 17, "设计 v0.6 · 尚未实现 · 箭头含义以本章节说明为准",
                           13, width - 48, "#788ba1", 400, False))
    output.append('</svg>')
    return "\n".join(output)


def script_json(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def markdown(data: dict) -> str:
    lines = [
        "# CodeCartia 架构与设计图解", "",
        "> 图解版本：0.1｜依据：设计 v0.6、推进 v0.4、验收样例 v0.3｜日期：2026-11-09", "",
        "本图解解释 CodeCartia 的产品设计。当前已有设计图解、模拟体验原型与可运行采购示例；",
        "产品分析器、CLI 与 Web 尚未实现，BS/AP 完整分析验收未执行，M1 基线未冻结、G1 未通过。",
        "图中的技术选型仍为候选；采购示例的功能测试不代表 CodeCartia 自动分析能力已经通过验收。", "",
        "[打开离线交互图解](index.html) · [图源与维护方法](README.md) · [完整设计](../CodeCartia-设计方案.md)", "",
        "按产品全景、系统架构、分析流程、核心模型、业务示例、界面导航、快照变化和规则改进阅读。",
        "各图箭头分别表示阅读关系、信息依赖或合成目标工程的条件路径，不能混作真实运行记录。", "",
    ]
    for number, graph in enumerate(data["graphs"], 1):
        guide = graph["plainGuide"]
        lines += [f'## {number:02d} {graph["title"]}', "", graph["question"], "",
                  "### 一句话看懂", "", guide["summary"], "", guide["scope"], "",
                  f'![{graph["title"]}](svgs/{graph["id"]}.svg)', "",
                  "### 怎么读这张图", ""]
        lines += [f'{index}. {item}' for index, item in enumerate(guide["reading"], 1)]
        lines += ["", "### 举个小例子", "", guide["example"], "",
                  "### 节点的通俗解释", "", "| 图中名称 | 通俗解释 |", "|---|---|"]
        for node in graph["nodes"]:
            label = node["label"].replace("\n", " ").replace("|", "\\|")
            explanation = node["plainExplanation"].replace("\n", " ").replace("|", "\\|")
            lines.append(f'| {label} | {explanation} |')
        lines += ["", "### 专业说明与设计边界", "", graph["description"], ""]
        lines += [f'- {note}' for note in graph.get("notes", [])]
        lines += ["", "依据：" + "；".join(
            f'[{source["label"]}]({source["path"]})（{source.get("section", "相关章节")}）'
            for source in graph.get("source", [])), "",
            f'[下载 SVG](svgs/{graph["id"]}.svg) · [编辑 Mermaid 图源](sources/{graph["id"]}.mmd)', "",
            "<details>", "<summary>查看 Mermaid 图源</summary>", "", "```mermaid", graph["mermaid"], "```", "", "</details>", ""]
    return "\n".join(lines)


def build() -> None:
    data = json.loads((ROOT / "graph-specs.json").read_text(encoding="utf-8-sig"))
    validate(data)
    template = (ROOT / "viewer-template.html").read_text(encoding="utf-8-sig")
    for marker in ("__GRAPH_DATA__", "__DIAGRAM_SVGS__"):
        if template.count(marker) != 1:
            raise ValueError(f"模板须恰好包含一个 {marker}")
    svgs = {graph["id"]: render_svg(graph) for graph in data["graphs"]}
    for folder in ("svgs", "sources"):
        (ROOT / folder).mkdir(exist_ok=True)
    for graph in data["graphs"]:
        (ROOT / "svgs" / f'{graph["id"]}.svg').write_text(svgs[graph["id"]], encoding="utf-8")
        (ROOT / "sources" / f'{graph["id"]}.mmd').write_text(graph["mermaid"] + "\n", encoding="utf-8")
    page = template.replace("__GRAPH_DATA__", script_json(data)).replace("__DIAGRAM_SVGS__", script_json(svgs))
    if "__GRAPH_DATA__" in page or "__DIAGRAM_SVGS__" in page:
        raise ValueError("HTML 尚有未替换标记")
    (ROOT / "index.html").write_text(page, encoding="utf-8")
    (ROOT / "architecture-guide.md").write_text(markdown(data), encoding="utf-8")
    print(f"已生成 {len(svgs)} 张 SVG、Mermaid 图源、Markdown 图解与离线 HTML。")


if __name__ == "__main__":
    build()
