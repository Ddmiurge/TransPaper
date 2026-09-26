/**
 * 字体特征（粗体 / 斜体）识别
 *
 * ── 背景 ──
 * pdf.js 的 `textContent.styles[fontName]` 只给出归一化后的 `fontFamily`
 * （serif / sans-serif / monospace），**没有字重信息**。早期据此下了「拿不到粗体」
 * 的结论，于是重排后的文档里所有段首小标题（`Identity vs. Projection Shortcuts.`）
 * 和斜体术语（`vs`、`bottleneck`）都退化成普通正文，一眼就不像原论文排出来的样子。
 *
 * 实际上信息是拿得到的，只是走另一条路：
 * `page.commonObjs.get(fontKey).name` 会给出**真实的 PostScript 字体名**，
 * 例如：
 *   - `CCHXUK+NimbusRomNo9L-Regu`     → 常规
 *   - `XORMUP+NimbusRomNo9L-Medi`     → 粗体（Nimbus 家族的 Medium 即粗体字重）
 *   - `RRPAQA+NimbusRomNo9L-ReguItal` → 斜体
 *   - `TVTMCE+NimbusRomNo9L-MediItal` → 粗斜体
 *
 * 前置条件：`commonObjs` 只有在**算子列表被求值之后**才会被填充，
 * 所以调用方必须先触发一次 `page.getOperatorList()`。
 *
 * ── 已知局限 ──
 * 这是按 PostScript 命名惯例做的字符串匹配，不是权威的字体元数据。
 * 覆盖 Times/Nimbus/Helvetica/Arial/Computer Modern 等主流学术排版的命名；
 * 遇到自造字体名（少见）会退化为「常规体」，也就是"不粗不斜"，不会出错内容。
 */

export interface FontTrait {
  bold: boolean;
  italic: boolean;
}

/** PostScript 名里表示粗体的常见片段 */
const BOLD_TOKENS = ['bold', 'medi', 'black', 'heavy', 'semibold', 'demi'];
/** PostScript 名里表示斜体的常见片段 */
const ITALIC_TOKENS = ['ital', 'oblique'];

/**
 * 从 PostScript 字体名判断字重与字形。
 *
 * 注意 `medi` 这一项不是笔误：Nimbus / URW 字体家族把粗体字重命名为 Medium
 * （Nimbus Roman No9 L 只有 Regular / Medium 两个字重），
 * 少了它，这套最常见的免费 Times 替代字体的粗体就识别不出来。
 */
export function classifyFontName(postScriptName: string): FontTrait {
  const name = postScriptName.toLowerCase();
  return {
    bold: BOLD_TOKENS.some((token) => name.includes(token)),
    italic: ITALIC_TOKENS.some((token) => name.includes(token)),
  };
}

/**
 * 取出一页里每个字体的特征。
 *
 * @param page pdf.js 的 page 对象；调用前其算子列表必须已被求值过
 * @param fontNames 本页文本项用到过的 fontName 集合
 */
export function collectFontTraits(page: any, fontNames: Iterable<string>): Map<string, FontTrait> {
  const traits = new Map<string, FontTrait>();
  for (const key of fontNames) {
    let name = '';
    try {
      name = String(page.commonObjs?.get(key)?.name ?? '');
    } catch {
      // 字体尚未装载 —— 保守按常规体处理，不猜
    }
    traits.set(key, classifyFontName(name));
  }
  return traits;
}
