/**
 * 翻译的领域契约。
 *
 * ── 为什么端口定义在这里，而不是直接用 fetch ──
 * 领域层零 IO 是这套架构的硬约束（见 `docs/01-architecture-overview.md`）。
 * 把 `TranslatorPort` 定义成接口、由基础设施层实现，带来两个具体好处：
 *   1. 调度逻辑（并发、重试、退避、取消）可以用一个假 Provider 在 Node 里完整测试，
 *      不必真的发请求 —— 这类逻辑的 bug 最难靠手测发现
 *   2. 换 Provider（DeepSeek → Kimi → 本地 Ollama → 将来 Rust 侧）只加一个适配器
 */

/** 一次翻译请求的最小单位：语义段落 */
export interface TranslationRequest {
  /** 请求标识。调度器用它把结果对应回原文块 */
  id: string;
  /** 待翻译的原文 */
  source: string;
}

/** 翻译失败的分类。**区分可重试与否是重试逻辑的前提** */
export type TranslationErrorKind =
  /** 网络不可达、超时 —— 可重试 */
  | 'network'
  /** 429 —— 可重试，且应当退避 */
  | 'rate-limit'
  /** 5xx —— 可重试 */
  | 'server'
  /** 401/403 —— 不可重试，Key 有问题 */
  | 'auth'
  /** 400 等请求本身有问题 —— 不可重试，重试只会重复失败 */
  | 'bad-request'
  /** 模型拒答或返回空 —— 可重试一次 */
  | 'empty'
  /** 用户主动取消 */
  | 'aborted';

export class TranslationError extends Error {
  readonly kind: TranslationErrorKind;
  readonly retryable: boolean;
  /** 服务端建议的等待毫秒数（429 的 Retry-After 头） */
  readonly retryAfterMs?: number;

  constructor(
    kind: TranslationErrorKind,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'TranslationError';
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) this.cause = options.cause;
    this.retryable =
      kind === 'network' ||
      kind === 'rate-limit' ||
      kind === 'server' ||
      kind === 'empty';
  }
}

/** 由基础设施层实现的翻译端口 */
export interface TranslatorPort {
  translate(source: string, signal: AbortSignal): Promise<string>;
}

/** 翻译配置。缓存键包含其中所有影响输出的字段 */
export interface TranslationConfig {
  provider: string;
  model: string;
  targetLang: string;
  /**
   * 提示词版本。改动提示词会改变输出，必须让旧缓存失效 ——
   * 否则「调了提示词却没生效」会浪费大量排查时间。
   * 修改 `buildTranslationPrompt` 时**必须同步递增**这个数字。
   */
  promptVersion: number;
}

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  targetLang: 'zh-Hans',
  promptVersion: 2,
};

// ────────────────────────────────────────────────────────────
// 缓存键
// ────────────────────────────────────────────────────────────

/**
 * 64 位 FNV-1a 哈希，输出 16 位十六进制。
 *
 * 用 64 位而不是 32 位：32 位在几万条记录时就可能出现生日碰撞，
 * 而碰撞在缓存里的表现是「两段不同的原文返回同一段译文」——
 * 静默且难查。
 */
export function hashText(text: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 缓存键。
 *
 * 组成项缺一不可，都是「改了它译文就会不同」的字段：
 *   - 原文哈希：内容变了必须重译
 *   - provider + model：换模型等于换译文
 *   - targetLang：换目标语言
 *   - 提示词版本：**这一项最容易漏**。漏了它，改完提示词发现输出没变，
 *     会误以为模型不听话，实际是命中了旧缓存
 */
export function cacheKeyOf(source: string, config: TranslationConfig): string {
  return [
    'v1',
    config.provider,
    config.model,
    config.targetLang,
    `p${config.promptVersion}`,
    hashText(source),
  ].join('|');
}

// ────────────────────────────────────────────────────────────
// 提示词
// ────────────────────────────────────────────────────────────

/**
 * 系统提示词。
 *
 * ── 每条要求都对应一个真实会出问题的点 ──
 * - 「只输出译文」：不写的话模型爱加「以下是翻译：」和解释
 * - 「保留 [1] (2) 这类引用编号」：论文里的引用编号是段落语义的一部分，
 *   被改写或删除会让读者无法对照
 * - 「保留行内公式与变量名」：`F(x) = H(x) - x` 这类内容译成中文就废了
 * - 「图表题注保持编号格式」：`Figure 3.` 必须对应到 `图 3.`，
 *   否则正文里的「如图 3 所示」就对不上了
 * - 「不要补充原文没有的内容」：模型爱在术语后加括号注释，破坏对照阅读
 */
export const TRANSLATION_SYSTEM_PROMPT = [
  '你是学术论文翻译引擎，把英文学术论文片段翻译成简体中文。',
  '',
  '必须遵守：',
  '1. 只输出译文本身，不要任何前言、解释、引号或"以下是译文"之类的话',
  '2. 保持学术语体：准确、简洁、书面化，不要口语化表达',
  '3. 行内数学公式必须原样保留：公式片段（含等号、运算符、括号、希腊字母、'
    + '上下标符号）逐字符照抄，不要翻译、不要改写、不要调整顺序、不要丢失符号；'
    + '例如 "where f(x) = y and g(z) ∈ W" 译为「其中 f(x) = y 且 g(z) ∈ W」',
  '4. 原样保留变量名、函数名、算法名与数据集名（如 F(x)、ResNet、ReLU、ImageNet）',
  '5. 原样保留引用编号与公式编号（如 [1]、[22, 21]、(3)）',
  '6. 图表题注保持编号格式：Figure N → 图 N，Table N → 表 N',
  '7. 不要补充原文没有的内容，不要加括号注释，不要扩写',
  '8. 专有名词首次出现时可用通行译名，但不要生造译名',
].join('\n');

export function buildTranslationPrompt(source: string): string {
  return source;
}

// ────────────────────────────────────────────────────────────
// 校验
// ────────────────────────────────────────────────────────────

/**
 * 译文质量校验：找出「明显不对劲」的译文，标记出来让用户看见。
 *
 * ── 为什么要做，而且为什么只做保守的检查 ──
 * LLM 会漏译、会自行扩写、会整段拒答。但自动重译有代价，
 * 而且误判会让用户对「异常标记」失去信任。
 * 所以这里只保留**几乎不可能误判**的规则：
 *   - 输出为空
 *   - 输出里完全没有中文字符（说明模型把原文照抄回来了）
 *   - 长度比例离谱（< 0.25 或 > 2.5）
 *
 * 返回 null 表示通过。
 */
export function checkTranslationQuality(source: string, target: string): string | null {
  const out = target.trim();
  if (!out) return '译文为空';
  if (!/[\u4e00-\u9fa5]/.test(out)) return '译文里没有中文，疑似照抄原文';

  const srcLen = source.trim().length;
  if (srcLen < 40) return null; // 短片段（标题、题注）比例波动大，不判

  const ratio = out.length / srcLen;
  if (ratio < 0.25) return `译文过短（长度比 ${ratio.toFixed(2)}），疑似漏译`;
  if (ratio > 2.5) return `译文过长（长度比 ${ratio.toFixed(2)}），疑似自行扩写`;
  return null;
}
