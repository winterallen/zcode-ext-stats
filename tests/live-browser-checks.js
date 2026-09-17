async (page) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto("http://127.0.0.1:8765/tests/preview.html");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const footer = button("会话统计");
  await footer.filter({ hasText: "240 tok/s" }).waitFor();
  await button("开始实时输出").click();
  await footer.filter({ hasText: "正在采样" }).waitFor({ timeout: 2000 });
  const samplingAt = Date.now();
  await footer.filter({ hasText: "≈" }).waitFor({ timeout: 1800 });
  const warmupMs = Date.now() - samplingAt;
  await footer.click();
  const popup = page.getByRole("region", { name: "会话统计详情" });
  if (!(await popup.innerText()).includes("240 tok/s")) throw Error("popup must retain session average");
  const streaming = await footer.innerText();
  await page.screenshot({ path: "E:/Tools/zcode-patcher/tests/preview-live.png" });
  await button("暂停输出").click();
  await footer.filter({ hasText: "等待输出" }).waitFor();
  await button("执行工具").click();
  await footer.filter({ hasText: "工具执行中" }).waitFor();
  await button("会话 B").click();
  await footer.filter({ hasText: "1 轮 · 2 次请求 · 240 tok/s" }).waitFor();
  await button("会话 A").click();
  await footer.filter({ hasText: "工具执行中" }).waitFor();
  await button("结束输出").click();
  await footer.filter({ hasText: "5 轮 · 55 次请求 · 240 tok/s" }).waitFor();
  await button("开始实时输出").click();
  await footer.filter({ hasText: "≈" }).waitFor();
  await button("结束输出").click();
  await footer.filter({ hasText: "5 轮 · 55 次请求 · 240 tok/s" }).waitFor();
  for (const format of ["legacy", "scoped"]) {
    await page.goto(`http://127.0.0.1:8765/tests/preview.html?port=${format}`);
    await footer.filter({ hasText: "240 tok/s" }).waitFor();
    await button("开始实时输出").click();
    await footer.filter({ hasText: "≈" }).waitFor();
    await button("结束输出").click();
  }
  return { streaming, warmupMs, checks: ["3.12.2 object main port", "legacy string and scoped ports", "sampling state before first speed", "binary MessagePort frames", "live footer / average popup", "idle timeout", "tool status", "session isolation", "terminal fallback", "new run"] };
}
