require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const upload = multer();

app.use(cors({ origin: "*" }));
app.use(express.json());

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

let tokenCache = null;
let tokenExp = 0;

// ===================== TOKEN =====================
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache && now < tokenExp) return tokenCache;

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(APP_KEY + ":" + APP_SECRET).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN
    })
  });

  const data = await res.json();

  if (!data.access_token) {
    console.error("TOKEN ERROR:", data);
    return null;
  }

  tokenCache = data.access_token;
  tokenExp = now + data.expires_in * 1000 - 60000;

  return tokenCache;
}

// ===================== TEST =====================
app.get("/", (req, res) => {
  res.json({ ok: true });
});

// ===================== UPLOAD =====================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.json({ success: false, error: "No file received" });
    }

    const token = await getAccessToken();
    if (!token) {
      return res.json({ success: false, error: "No Dropbox token" });
    }

    const folder = req.body.folderPath || "/UPLOADS";

    // FIX: handle missing originalname (PDF blobs)
    const filename =
      req.file.originalname || `file_${Date.now()}.bin`;

    const path = `${folder}/${Date.now()}_${filename}`;

    // ================= DROPBOX UPLOAD =================
    const uploadRes = await fetch(
      "https://content.dropboxapi.com/2/files/upload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path,
            mode: "add",
            autorename: true
          })
        },
        body: req.file.buffer
      }
    );

    let uploadData;
    try {
      uploadData = await uploadRes.json();
    } catch (e) {
      const text = await uploadRes.text();
      console.error("DROPBOX RAW ERROR:", text);
      return res.json({ success: false, error: "Dropbox failed", raw: text });
    }

    if (!uploadData.path_lower) {
      return res.json({
        success: false,
        error: "Dropbox rejected file",
        details: uploadData
      });
    }

    // ================= SHARE LINK =================
    let url = null;

    try {
      const linkRes = await fetch(
        "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ path: uploadData.path_lower })
        }
      );

      const linkData = await linkRes.json();
      if (linkData?.url) {
        url = linkData.url.replace("?dl=0", "?raw=1");
      }
    } catch (e) {
      console.log("share link failed, continuing...");
    }

    // ================= ALWAYS SAFE RESPONSE =================
    return res.json({
      success: true,
      url,
      path: uploadData.path_lower
    });

  } catch (err) {
    console.error("UPLOAD CRASH:", err);
    return res.json({
      success: false,
      error: err.message || "Server crash"
    });
  }
});

// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});