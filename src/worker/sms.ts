// 阿里云「短信认证」（号码认证服务 Dypnsapi）封装
// 适用：个人实名账号即可使用，无需企业资质、无需自建签名/模板（用平台赠送的）。
// 验证码由阿里云生成与保管，我们用 SendSmsVerifyCode 下发、CheckSmsVerifyCode 核验，
// 自己不存验证码明文，只存 outId 做关联。
//
// 调用走 RPC 风格 + HMAC-SHA1 签名（与 Aliyun OpenAPI 官方 SDK 同算法），
// 用 Web Crypto 实现，完全兼容 Cloudflare Workers（不依赖 Node SDK / axios）。

import type { Env } from "./index";

const DYPNSAPI_ENDPOINT = "https://dypnsapi.aliyuncs.com/";
const API_VERSION = "2017-05-25";

export interface SmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
}

// 从 Worker 环境变量读取短信配置；缺任一项即视为「未配置」
export function getSmsConfig(env: Env): SmsConfig | null {
  const accessKeyId = (env.ALIBABA_CLOUD_ACCESS_KEY_ID || "").trim();
  const accessKeySecret = (env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || "").trim();
  const signName = (env.ALIBABA_SMS_SIGN_NAME || "").trim();
  const templateCode = (env.ALIBABA_SMS_TEMPLATE_CODE || "").trim();
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) return null;
  return { accessKeyId, accessKeySecret, signName, templateCode };
}

// ---- Aliyun RPC 签名（HMAC-SHA1）----
// 与官方 @alicloud/pop-core 的 percentEncode 一致：
// encodeURIComponent 后再把 + * %7E 还原/转义，'!' '(' ')' 等保持原样。
function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function hmacSha1(secret: string, stringToSign: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret + "&"),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stringToSign));
  return base64FromArrayBuffer(sig);
}

interface AliyunResponse {
  Code?: string;
  Success?: boolean;
  Message?: string;
  Model?: Record<string, unknown>;
  RequestId?: string;
}

// 阿里云错误码 → 用户可读文案。
// 阿里云原始 Message 常年是 "UNKNOWN"/空串，直接展示给用户毫无信息量；
// 真正的原因是 Code，这里把常见码翻成人话，未知码则原样带上 Code 便于排查。
const SMS_CODE_HINTS: Record<string, string> = {
  "biz.FREQUENCY": "验证码发送过于频繁，请稍后再试",
  "isv.BUSINESS_LIMIT_CONTROL": "验证码发送过于频繁，请稍后再试",
  "isv.DAY_LIMIT_CONTROL": "今日验证码发送次数已达上限，请明天再试",
  "isv.OUT_OF_SERVICE": "短信服务已停机（账户可能欠费），请联系管理员",
  "isv.ACCOUNT_ABNORMAL": "短信服务账户异常，请联系管理员",
  "isv.ACCOUNT_NOT_EXISTS": "短信服务账户不存在，请联系管理员",
  "isp.RAM_PERMISSION_DENY": "短信服务权限不足，请联系管理员",
  "isv.FUNCTION_NOT_OPENED": "短信认证服务未开通，请联系管理员",
  "isv.PRODUCT_UNSUBSCRIBE": "短信认证服务未开通，请联系管理员",
  "isv.PRODUCT_UN_SUBSCRIPT": "短信认证服务未开通，请联系管理员",
  "isv.SMS_SIGNATURE_ILLEGAL": "短信签名异常，请联系管理员",
  "isv.SMS_TEMPLATE_ILLEGAL": "短信模板异常，请联系管理员",
  "isv.MOBILE_NUMBER_ILLEGAL": "手机号格式不正确",
  "isv.ILLEGAL_ARGUMENT": "请求参数不合法，请联系管理员",
  "isp.UNKNOWN_ERR_CODE": "运营商暂时异常，请稍后重试",
  "isp.SYSTEM_ERROR": "短信服务暂时异常，请稍后重试",
  // CheckSmsVerifyCode 校验类失败：验证码不匹配 / 已过期 / 被重新发送覆盖 / 错误次数超限。
  // 这是用户输入侧的问题（可自行重试），不是服务故障 —— 必须与欠费/权限类区分开。
  "isv.ValidateFail": "验证码错误或已失效，请点击「重新获取」并输入最新一条短信的验证码",
};

async function callDypnsapiRaw(
  cfg: SmsConfig,
  action: string,
  params: Record<string, string>
): Promise<{ httpStatus: number; text: string; data: AliyunResponse }> {
  const common: Record<string, string> = {
    AccessKeyId: cfg.accessKeyId,
    Action: action,
    Format: "JSON",
    Version: API_VERSION,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
    // 必须是 GMT/UTC 的 ISO8601，且不含毫秒（阿里云要求 YYYY-MM-DDThh:mm:ssZ）
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const all = { ...common, ...params };
  const keys = Object.keys(all).sort();
  const canonical = keys.map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`).join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  const signature = await hmacSha1(cfg.accessKeySecret, stringToSign);
  const url = `${DYPNSAPI_ENDPOINT}?${canonical}&Signature=${percentEncode(signature)}`;

  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let data: AliyunResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`阿里云返回非 JSON [HTTP ${res.status}]：${text.slice(0, 300)}`);
  }
  return { httpStatus: res.status, text, data };
}

async function callDypnsapi(cfg: SmsConfig, action: string, params: Record<string, string>): Promise<AliyunResponse> {
  const { httpStatus, text, data } = await callDypnsapiRaw(cfg, action, params);
  if (data.Code !== "OK" && data.Success !== true) {
    // 阿里云原始 Message 多为 "UNKNOWN"/空串，真正原因在 Code 里
    // （biz.FREQUENCY=发送频率超限、isv.OUT_OF_SERVICE=欠费停机、
    //   isp.RAM_PERMISSION_DENY=权限不足、isv.FUNCTION_NOT_OPENED=服务未开通）。
    // 原始响应只写入日志（此前曾被误导为「欠费」，实际是频率超限，务必留痕）。
    const opLabel = action === "SendSmsVerifyCode" ? "短信发送失败" : "验证码校验失败";
    const code = data.Code || "";
    console.error(`[aliyun] ${action} failed: HTTP ${httpStatus} code=${code || "(空)"} raw=${text.slice(0, 300)}`);
    throw new Error(SMS_CODE_HINTS[code] || `${opLabel}（错误码：${code || "未知"}），请稍后重试`);
  }
  return data;
}

// 发送短信验证码：验证码由平台生成（TemplateParam 用 ##code## 占位），
// 平台通过赠送签名下发赠送模板。OutId 透传，供核验时关联。
//
// ⚠️ 关键：TemplateParam 用 "##code##" 占位符让阿里云动态生成验证码时，
// 官方文档要求 **CodeType 必填**（指定验证码生成规则）。此前漏传 CodeType，
// 导致占位符未被替换、阿里云侧未为手机号建立有效验证码记录，核验永远
// isv.ValidateFail —— 这是「验证码明明收到了却校验失败」的根因。
export async function sendSmsCode(cfg: SmsConfig, phone: string, outId: string): Promise<{ ok: true; bizId?: string; verifyCode?: string }> {
  const data = await callDypnsapi(cfg, "SendSmsVerifyCode", {
    PhoneNumber: phone,
    SignName: cfg.signName,
    TemplateCode: cfg.templateCode,
    CountryCode: "86",
    // 验证码/有效期占位：平台自动生成并填入。变量名须与赠送模板一致（code/min）。
    TemplateParam: JSON.stringify({ code: "##code##", min: "5" }),
    // 验证码生成规则：1=纯数字验证码（与赠送模板 ${code} 变量匹配）。
    // 缺这个参数，##code## 不会被动态替换 → 校验必然 ValidateFail。
    CodeType: "1",
    CodeLength: "4",       // 验证码 4 位
    ValidTime: "300",      // 验证码有效 300 秒
    DuplicatePolicy: "1",  // 有效期内重发时覆盖旧码（旧码失效）
    OutId: outId,
  });
  const model = data.Model || {};
  return {
    ok: true,
    bizId: model.BizId as string | undefined,
    // ReturnVerifyCode 未开启时此字段通常不存在；留作调试观察（不落库、不返回前端）
    verifyCode: model.VerifyCode as string | undefined,
  };
}

// 核验短信验证码。
// ⚠️ Model.VerifyResult 官方文档取值是字符串 "PASS"（通过）/ "UNKNOWN"（不通过），
// 不是 1/0 —— 此前按数字判断导致验证码正确也永远校验失败（Number("PASS") = NaN）。
// 这里同时兼容部分网关历史返回数字 1/0 的情况。
export async function verifySmsCode(
  cfg: SmsConfig,
  phone: string,
  code: string,
  outId: string
): Promise<{ ok: true; result: number }> {
  const data = await callDypnsapi(cfg, "CheckSmsVerifyCode", {
    PhoneNumber: phone,
    VerifyCode: code,
    OutId: outId,
    CountryCode: "86",
    // ⚠️ CaseAuthPolicy 合法值只有 1（不区分大小写）/ 2（区分大小写）。
    // 此前误传 "0"（非法值），阿里云拿到 0 无法执行核验策略 → 永远 isv.ValidateFail。
    // 这是「验证码明明正确却校验失败」的真正根因（对照实验已验证：0 失败、1 通过）。
    CaseAuthPolicy: "1",
  });
  const raw = data.Model?.VerifyResult;
  const pass = raw === "PASS" || raw === "1" || raw === 1;
  // 成功/失败路径都留痕（脱敏），VerifyResult 的真实取值此前靠文档猜（PASS vs 1），
  // 若线上再出现「验证码正确但判失败」，靠这条日志一锤定音。
  console.log(`[sms-verify] phone=${phone.slice(0, 3)}**** VerifyResult=${JSON.stringify(raw)} pass=${pass}`);
  return { ok: true, result: pass ? 1 : 0 };
}

