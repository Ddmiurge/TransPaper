//! 桌面翻译链路（I22）：LLM HTTP 通道。
//!
//! ── 为什么请求要由 Rust 发 ──
//! WebView 里的 `fetch` 直连 LLM 服务会被 CORS 拦住（这些服务不给浏览器发
//! CORS 头）；开发期靠 Vite dev server 的 `/api/llm` 代理绕过，但打包后的
//! 桌面应用没有 dev server —— 请求会打到 `tauri://localhost/api/llm` 直接 404。
//! 由 Rust 侧发出（reqwest）则完全没有 CORS 概念，这也是 ADR-011 预定的路线。
//!
//! ── 返回形态 ──
//! **不做错误分类**，把 `status + body + retry-after` 原样交给前端：
//! 错误分类（401/429/5xx → 重试行为）是领域逻辑，测试已锁在前端
//! （`classifyHttpError`），Rust 只做透明管道，避免同一规则写两份。

use serde::Serialize;

/// 一次 LLM HTTP 调用的结果（透传给前端做领域层分类）
#[derive(Debug, Serialize)]
pub struct LlmHttpResult {
    pub status: u16,
    pub body: String,
    /// 响应头 `Retry-After`（秒）换算成毫秒；没有则 None
    pub retry_after_ms: Option<u64>,
}

/// 发送 POST（JSON + Bearer 认证）。
///
/// 独立成自由函数而不是 command 的内联体：单元测试可以直接打本地 mock。
pub async fn http_post_json(
    url: &str,
    api_key: &str,
    body: &str,
    timeout_ms: u64,
) -> Result<LlmHttpResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .body(body.to_owned())
        .send()
        .await
        .map_err(|e| {
            // reqwest 的 Display 把超时细节吞掉（只剩 "error sending request"），
            // 而 is_timeout() 才是权威判断。规范化消息让前端能把
            // 「超时」与「网络不通」区分开（isTimeoutError 按短语匹配）。
            if e.is_timeout() {
                "request timed out".to_string()
            } else {
                e.to_string()
            }
        })?;

    let status = response.status().as_u16();
    let retry_after_ms = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|seconds| (seconds * 1000.0) as u64);
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;

    Ok(LlmHttpResult {
        status,
        body: text,
        retry_after_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::http_post_json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// 起一个只应答一次的极简 HTTP mock，返回其 URL。
    /// 不引入测试框架依赖 —— 需要验证的就是「bytes 进 bytes 出」。
    fn spawn_mock(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 8192];
            let _ = stream.read(&mut buf);
            stream.write_all(response.as_bytes()).expect("write");
        });
        format!("http://{addr}/v1/chat/completions")
    }

    #[test]
    fn 透传_状态码与响应体() {
        let url = spawn_mock(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
        );
        let result = tauri::async_runtime::block_on(http_post_json(
            &url,
            "sk-test",
            "{\"model\":\"m\"}",
            5000,
        ))
        .expect("请求成功");
        assert_eq!(result.status, 200);
        assert!(result.body.contains("\"ok\":true"));
        assert_eq!(result.retry_after_ms, None);
    }

    #[test]
    fn 透传_retry_after_供限流退避() {
        let url = spawn_mock(
            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 2\r\nContent-Length: 2\r\n\r\n{}",
        );
        let result = tauri::async_runtime::block_on(http_post_json(
            &url,
            "sk-test",
            "{}",
            5000,
        ))
        .expect("请求成功");
        assert_eq!(result.status, 429);
        assert_eq!(result.retry_after_ms, Some(2000));
    }

    #[test]
    fn 超时返回错误而不是挂死() {
        // accept 之后不回话 —— 客户端只能超时
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            let (_stream, _) = listener.accept().expect("accept");
            std::thread::sleep(std::time::Duration::from_secs(5));
        });
        let result = tauri::async_runtime::block_on(http_post_json(
            &format!("http://{addr}/v1/chat/completions"),
            "sk-test",
            "{}",
            300,
        ));
        let err = result.expect_err("应当超时");
        assert!(err.contains("timed out") || err.contains("timeout"), "实际错误: {err}");
    }
}
