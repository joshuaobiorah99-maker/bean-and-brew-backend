// Copies your existing menu-data.json into the database (run once).
// Usage:  node seed-menu.js

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("Add SUPABASE_URL and SUPABASE_SERVICE_KEY to your .env file first.");
    process.exit(1);
}

const file = path.join(__dirname, "menu-data.json");

if (!fs.existsSync(file)) {
    console.log("menu-data.json was not found next to this file.");
    process.exit(1);
}

const items = JSON.parse(fs.readFileSync(file, "utf8"));

const rows = items
    .map(function (item) {
        return {
            name: String(item.name || "").trim(),
            price: Number(item.price),
            category: String(item.category || "other"),
            image: String(item.image || ""),
            description: String(item.description || "")
        };
    })
    .filter(function (row) {
        return row.name && Number.isFinite(row.price);
    });

const headers = {
    apikey: SUPABASE_KEY,
    "Content-Type": "application/json",
    Prefer: "resolution=ignore-duplicates,return=minimal"
};

// Old-style (JWT) keys also need the Authorization header.
if (SUPABASE_KEY.startsWith("eyJ")) {
    headers.Authorization = "Bearer " + SUPABASE_KEY;
}

(async function () {

    const response = await fetch(
        SUPABASE_URL + "/rest/v1/menu_items?on_conflict=name_lower",
        {
            method: "POST",
            headers: headers,
            body: JSON.stringify(rows)
        }
    );

    if (!response.ok) {
        console.log("Upload failed:", response.status, await response.text());
        console.log("Did you run schema.sql in the Supabase SQL Editor first?");
        process.exit(1);
    }

    console.log("Done. " + rows.length + " menu item(s) copied to the database.");

})().catch(function (error) {
    console.log("Upload failed:", error.message);
    process.exit(1);
});