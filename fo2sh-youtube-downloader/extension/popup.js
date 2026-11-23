const status = document.getElementById("status");
const btn = document.getElementById("update");

chrome.runtime.sendMessage({ type: "yt-ping" }, (res) => {
  if (res && res.ok) {
    status.textContent = `جاهز. yt-dlp ${res.ytdlp}${res.ffmpeg ? "، ffmpeg موجود" : "، ffmpeg ناقص: شغّل install.command تاني"}`;
  } else {
    status.textContent = "البرنامج المساعد مش متسطب. شغّل install.command مرة واحدة (التعليمات في ملف اقرأني).";
    btn.disabled = true;
  }
});

btn.addEventListener("click", () => {
  btn.disabled = true;
  btn.textContent = "بيحدّث...";
  chrome.runtime.sendMessage({ type: "yt-update" }, (res) => {
    btn.textContent = res && res.ok ? "تم التحديث" : "التحديث فشل";
    btn.disabled = false;
  });
});
