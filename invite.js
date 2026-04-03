(function () {
  var params = new URLSearchParams(window.location.search);
  var code = (params.get("code") || "").trim().toUpperCase();
  var fallbackDownload = "https://dhansourcecapital.com";
  var downloadUrl = params.get("download") || fallbackDownload;

  if (code) {
    try {
      localStorage.setItem("referralCode", code);
    } catch (_) {
      // ignore storage failures in strict/private browser mode
    }
  }

  var refCodeEl = document.getElementById("refCode");
  var downloadBtn = document.getElementById("downloadBtn");

  if (refCodeEl) refCodeEl.textContent = code || "No code provided";
  if (downloadBtn) downloadBtn.href = downloadUrl;
})();
