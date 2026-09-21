const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const { GoogleGenAI } = require("@google/genai");

dotenv.config();

const app = express();
const PORT = 3000;

// --------------------------------------------------
// CONFIG
// --------------------------------------------------

const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

const upload = multer({
    dest: UPLOAD_DIR,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500 MB
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// GEMINI
// --------------------------------------------------

if (!process.env.GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY is missing from .env");
    process.exit(1);
}

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// --------------------------------------------------
// HOME
// --------------------------------------------------

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------------
// VIDEO ANALYSIS
// --------------------------------------------------

app.post("/analyze", upload.single("video"), async (req, res) => {

    let uploadedFile = null;

    try {

        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: "No video was uploaded."
            });
        }

        console.log("\n=================================");
        console.log("🎬 VIDEO RECEIVED");
        console.log("=================================");
        console.log("File:", req.file.originalname);
        console.log("Size:", (req.file.size / 1024 / 1024).toFixed(2), "MB");

        // --------------------------------------------------
        // DETERMINE MIME TYPE
        // --------------------------------------------------

        let mimeType = req.file.mimetype;

        if (!mimeType || mimeType === "application/octet-stream") {
            mimeType = "video/mp4";
        }

        console.log("MIME:", mimeType);

        // --------------------------------------------------
        // UPLOAD VIDEO TO GEMINI
        // --------------------------------------------------

        console.log("\n⬆️ Uploading video to Gemini...");

        uploadedFile = await ai.files.upload({
            file: req.file.path,
            config: {
                mimeType: mimeType
            }
        });

        console.log("✓ Uploaded");
        console.log("Gemini file:", uploadedFile.name);

        // --------------------------------------------------
        // WAIT FOR GEMINI TO PROCESS VIDEO
        // --------------------------------------------------

        let videoFile = await ai.files.get({
            name: uploadedFile.name
        });

        while (videoFile.state === "PROCESSING") {

            console.log("⏳ Gemini is processing the video...");

            await new Promise(resolve => {
                setTimeout(resolve, 3000);
            });

            videoFile = await ai.files.get({
                name: uploadedFile.name
            });
        }

        if (videoFile.state === "FAILED") {
            throw new Error("Gemini failed to process the video.");
        }

        console.log("✓ Video processing complete");

        // --------------------------------------------------
        // HOOK ANALYSIS PROMPT
        // --------------------------------------------------

        const prompt = `
You are an expert short-form video editor and hook analyst.

Analyze the ENTIRE uploaded video.

Your goal is to find the strongest moments that could be
used as the opening hook of a short-form video.

IMPORTANT:

Do NOT automatically assume that the first few seconds
are the strongest hook.

Analyze the entire video before selecting the candidates.

Look at:

1. Spoken dialogue.
2. Transcript meaning.
3. Exact wording.
4. Curiosity.
5. Questions.
6. Strong claims.
7. Unexpected information.
8. Conflict.
9. Emotional intensity.
10. Story reveals.
11. Surprising moments.
12. Pattern interrupts.
13. Pacing.
14. Whether the viewer has a reason to continue watching.
15. Whether the selected moment can work as an opening.
16. Whether the moment requires information from earlier
    in the video.

Find the 5 strongest hook candidates.

A hook should preferably:

- Grab attention quickly.
- Create curiosity.
- Make the viewer want to know what happens next.
- Be understandable with little or no previous context.
- Have strong spoken wording.
- Be useful as the opening of a short-form video.

For each hook provide:

- rank
- start timestamp in seconds
- end timestamp in seconds
- score from 0 to 100
- hook type
- exact transcript
- why it works
- whether previous context is required

Also provide:

- a short summary of the entire video
- the strongest hook
- the overall topic

HOOK TYPES MAY INCLUDE:

Curiosity
Question
Shock
Unexpected Fact
Story
Conflict
Result First
Emotional
Mystery
Reveal
Problem
Challenge
Pattern Interrupt
Strong Claim

SCORING:

Use this general scoring system:

20 points = immediate attention
20 points = curiosity
15 points = clarity
15 points = strong wording
10 points = emotional/interesting impact
10 points = open loop
10 points = works without previous context

Return ONLY valid JSON.

Use this exact structure:

{
  "video_summary": "",
  "topic": "",
  "best_hook_rank": 1,
  "hooks": [
    {
      "rank": 1,
      "start": 0,
      "end": 5,
      "score": 90,
      "type": "Curiosity",
      "transcript": "",
      "reason": "",
      "requires_context": false
    }
  ]
}

Make sure start and end are numeric seconds.

Do not use markdown.

Do not put the JSON inside a code block.
`;

        // --------------------------------------------------
        // ASK GEMINI TO ANALYZE VIDEO
        // --------------------------------------------------

        console.log("\n🧠 Gemini is analyzing the entire video...");

const interaction = await ai.interactions.create({
    model: "gemini-3.6-flash",
    input: [
        {
            type: "text",
            text: prompt
        },
        {
            type: "video",
            uri: videoFile.uri,
            mime_type: videoFile.mimeType
        }
    ]
});

let resultText = interaction.output_text;

        console.log("\n✓ Gemini analysis complete");

        // --------------------------------------------------
        // CLEAN AI RESPONSE
        // --------------------------------------------------

        resultText = resultText
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

        let analysis;

        try {
            analysis = JSON.parse(resultText);
        } catch (parseError) {

            console.error("❌ Could not parse Gemini JSON");

            console.log("Gemini response:");
            console.log(resultText);

            throw new Error(
                "Gemini returned an invalid JSON response."
            );
        }

        // --------------------------------------------------
        // RETURN RESULT
        // --------------------------------------------------

        res.json({
            success: true,
            filename: req.file.originalname,
            analysis: analysis
        });

    } catch (error) {

        console.error("\n❌ ANALYSIS ERROR");
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message || "Something went wrong."
        });

    } finally {

        // --------------------------------------------------
        // DELETE LOCAL UPLOAD
        // --------------------------------------------------

        if (req.file && req.file.path) {

            fs.unlink(req.file.path, () => {
                console.log("🗑️ Temporary upload deleted.");
            });
        }
    }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {

    console.log("");
    console.log("=================================");
    console.log("🔥 HOOK FINDER");
    console.log("=================================");
    console.log(`Running at: http://localhost:${PORT}`);
    console.log("=================================");
    console.log("");
});