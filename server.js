require("dotenv").config();

const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// =========================
// SETTINGS (from .env locally, or Render's Environment Variables)
// =========================

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_API_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";
const EMAIL_FROM = process.env.EMAIL_FROM || "Bean & Brew <onboarding@resend.dev>";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "";

const REQUEST_TIMEOUT_MS = 10000;

// =========================
// SMALL HELPERS
// =========================

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    error.isHttpError = true;
    return error;
}

function send(res, status, data) {
    res.writeHead(status);
    res.end(JSON.stringify(data));
}

function safeDecode(text) {
    try {
        return decodeURIComponent(text);
    } catch (error) {
        throw httpError(400, "Bad request");
    }
}

// fetch() that gives up after a few seconds instead of hanging.

async function fetchWithTimeout(url, options) {

    const controller = new AbortController();

    const timer = setTimeout(function () {
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        return await fetch(
            url,
            Object.assign({}, options, { signal: controller.signal })
        );
    } finally {
        clearTimeout(timer);
    }
}

// =========================
// DATABASE (Supabase, over HTTPS)
// =========================

async function db(method, pathAndQuery, body, prefer) {

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set");
    }

    const headers = {
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json"
    };

    // Old-style (JWT) keys also need the Authorization header.
    if (SUPABASE_KEY.startsWith("eyJ")) {
        headers.Authorization = "Bearer " + SUPABASE_KEY;
    }

    if (prefer) {
        headers.Prefer = prefer;
    }

    const response = await fetchWithTimeout(
        SUPABASE_URL + "/rest/v1/" + pathAndQuery,
        {
            method: method,
            headers: headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        }
    );

    const text = await response.text();

    let data = null;

    try {
        data = text ? JSON.parse(text) : null;
    } catch (error) {
        data = null;
    }

    if (!response.ok) {

        const error = new Error(
            (data && data.message) ||
            ("Database error " + response.status)
        );

        error.code = data && data.code;
        error.dbStatus = response.status;

        throw error;
    }

    return data;
}

function isDuplicateError(error) {
    return error && error.code === "23505";
}

function enc(value) {
    return encodeURIComponent(value);
}

// ---------- menu ----------

const MENU_COLUMNS = "name,price,category,image,description";

function cleanMenuRow(row) {
    return {
        name: row.name,
        price: Number(row.price),
        category: row.category,
        image: row.image || "",
        description: row.description || ""
    };
}

async function readMenu() {

    const rows = await db(
        "GET",
        "menu_items?select=" + MENU_COLUMNS + "&order=id.asc"
    );

    return rows.map(cleanMenuRow);
}

async function findMenuItem(name) {

    const rows = await db(
        "GET",
        "menu_items?select=" + MENU_COLUMNS +
        "&name_lower=eq." + enc(String(name).toLowerCase()) +
        "&limit=1"
    );

    return rows.length ? cleanMenuRow(rows[0]) : null;
}

// ---------- orders ----------

function rowToOrder(row) {
    return {
        orderNumber: row.order_number,
        createdAt: row.created_at,
        customer: {
            name: row.customer_name,
            phone: row.customer_phone,
            orderType: row.order_type,
            note: row.note
        },
        items: row.items,
        total: Number(row.total)
    };
}

function orderToRow(order) {
    return {
        order_number: order.orderNumber,
        created_at: order.createdAt,
        customer_name: order.customer.name,
        customer_phone: order.customer.phone,
        order_type: order.customer.orderType,
        note: order.customer.note,
        items: order.items,
        total: order.total
    };
}

function newOrderNumber() {
    return "BB" + Math.floor(100000 + Math.random() * 900000);
}

// Saves the order. In the very rare case the random order number
// already exists, it simply tries a new number.

async function saveOrder(order) {

    for (let attempt = 0; attempt < 3; attempt++) {

        order.orderNumber = newOrderNumber();

        try {
            await db(
                "POST",
                "orders",
                orderToRow(order),
                "return=minimal"
            );

            return;

        } catch (error) {

            if (!isDuplicateError(error)) {
                throw error;
            }
        }
    }

    throw new Error("Could not create a unique order number");
}

async function deleteOrder(orderNumber) {

    await db(
        "DELETE",
        "orders?order_number=eq." + enc(orderNumber),
        undefined,
        "return=minimal"
    );
}

// =========================
// EMAIL (Resend, over HTTPS)
// =========================

function buildOrderEmail(order) {

    const lines = order.items.map(function (item) {
        return (
            "- " + item.name +
            " x" + item.quantity +
            "  (₦" + (item.price * item.quantity).toLocaleString("en-NG") + ")"
        );
    });

    return (
        "A new order was placed on Bean & Brew\n\n" +
        "Order number: " + order.orderNumber + "\n" +
        "Time: " + order.createdAt + "\n\n" +
        "Customer: " + order.customer.name + "\n" +
        "Phone: " + order.customer.phone + "\n" +
        "Type: " + order.customer.orderType + "\n" +
        "Note: " + (order.customer.note || "None") + "\n\n" +
        "Items:\n" + lines.join("\n") + "\n\n" +
        "Total: ₦" + order.total.toLocaleString("en-NG") + "\n"
    );
}

async function sendOwnerEmail(order) {

    if (!RESEND_API_KEY || !OWNER_EMAIL) {
        throw new Error("RESEND_API_KEY / OWNER_EMAIL are not set");
    }

    const response = await fetchWithTimeout(RESEND_API_URL, {

        method: "POST",

        headers: {
            Authorization: "Bearer " + RESEND_API_KEY,
            "Content-Type": "application/json",
            "User-Agent": "bean-and-brew-backend"
        },

        body: JSON.stringify({
            from: EMAIL_FROM,
            to: [OWNER_EMAIL],
            subject: "New Bean & Brew order " + order.orderNumber,
            text: buildOrderEmail(order)
        })
    });

    if (!response.ok) {

        const detail = await response.text();

        throw new Error(
            "Email service answered " + response.status + ": " +
            detail.slice(0, 300)
        );
    }
}

// =========================
// ADMIN SECURITY
// =========================

// Wrong-password attempts are counted per IP address.
// After 10 wrong attempts, that IP is blocked for 15 minutes.

const failedAttempts = {};
const MAX_FAILED_ATTEMPTS = 10;
const BLOCK_WINDOW_MS = 15 * 60 * 1000;

function getClientIP(req) {

    const forwarded = req.headers["x-forwarded-for"];

    if (forwarded) {
        return forwarded.split(",")[0].trim();
    }

    return req.socket.remoteAddress;
}

function isBlocked(ip) {

    const record = failedAttempts[ip];

    if (!record) {
        return false;
    }

    if (Date.now() - record.first > BLOCK_WINDOW_MS) {
        delete failedAttempts[ip];
        return false;
    }

    return record.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(ip) {

    const record = failedAttempts[ip];

    if (!record || Date.now() - record.first > BLOCK_WINDOW_MS) {
        failedAttempts[ip] = { count: 1, first: Date.now() };
    } else {
        record.count++;
    }
}

function passwordMatches(supplied) {

    const expected = process.env.ADMIN_PASSWORD;

    // If ADMIN_PASSWORD is missing, nobody gets in.
    if (!expected || typeof supplied !== "string") {
        return false;
    }

    const a = crypto.createHash("sha256").update(supplied).digest();
    const b = crypto.createHash("sha256").update(expected).digest();

    return crypto.timingSafeEqual(a, b);
}

// Returns true if the request is from the admin.
// Otherwise it sends the error response itself and returns false.

function requireAdmin(req, res) {

    const ip = getClientIP(req);

    if (isBlocked(ip)) {

        send(res, 429, {
            message: "Too many wrong attempts. Try again in 15 minutes."
        });

        return false;
    }

    if (passwordMatches(req.headers["x-admin-password"])) {
        return true;
    }

    recordFailure(ip);

    send(res, 401, { message: "Unauthorized" });

    return false;
}

// =========================
// CORS
// =========================

const allowedOrigins = [
    "https://joshuaobiorah99-maker.github.io"
];

// Any port on localhost / 127.0.0.1 is allowed for testing (Live Server).
const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin) {
    return allowedOrigins.includes(origin) || localOrigin.test(origin);
}

// =========================
// READ REQUEST BODY (max 100 KB)
// =========================

function readBody(req) {

    return new Promise(function (resolve, reject) {

        let body = "";
        let size = 0;
        let finished = false;

        req.on("data", function (chunk) {

            if (finished) {
                return;
            }

            size += chunk.length;

            if (size > 100000) {
                finished = true;
                reject(httpError(413, "Request too large"));
                return;
            }

            body += chunk;
        });

        req.on("end", function () {
            if (!finished) {
                finished = true;
                resolve(body);
            }
        });

        req.on("error", reject);
    });
}

async function readJSONBody(req) {

    const text = await readBody(req);

    try {
        return JSON.parse(text);
    } catch (error) {
        throw httpError(400, "Invalid JSON");
    }
}

// =========================
// ROUTES
// =========================

// ---------- customer: create order ----------

async function createOrder(req, res) {

    const orderData = await readJSONBody(req);

    const customer = orderData.customer || {};
    const submittedItems = orderData.items || {};

    const name = String(customer.name || "").trim();
    const phone = String(customer.phone || "").trim();
    const orderType = String(customer.orderType || "").trim();
    const note = String(customer.note || "").trim();

    if (
        !name ||
        !phone ||
        !["Pickup", "Delivery"].includes(orderType)
    ) {
        throw httpError(400, "Please complete the customer details.");
    }

    // Prices always come from the database menu, never from the browser.

    let menuItems;

    try {
        menuItems = await readMenu();
    } catch (error) {
        return failOrder(res, "load menu", error);
    }

    const items = Object.entries(submittedItems)

        .map(function ([itemName, item]) {

            const menuItem = menuItems.find(function (product) {
                return product.name === itemName;
            });

            const quantity = Number(item && item.quantity);

            if (
                !menuItem ||
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 100
            ) {
                return null;
            }

            return {
                name: menuItem.name,
                price: Number(menuItem.price),
                quantity: quantity
            };
        })

        .filter(Boolean);

    if (items.length === 0) {
        throw httpError(400, "Your order is empty.");
    }

    const total = items.reduce(function (sum, item) {
        return sum + item.price * item.quantity;
    }, 0);

    const order = {
        orderNumber: "",
        createdAt: new Date().toISOString(),
        customer: { name, phone, orderType, note },
        items,
        total
    };

    // An order only counts if it is BOTH saved AND emailed to you.
    // If the email fails, the saved order is removed and the
    // customer is told it did not go through.

    let saved = false;

    try {

        await saveOrder(order);
        saved = true;

        await sendOwnerEmail(order);

    } catch (error) {

        if (saved) {

            try {
                await deleteOrder(order.orderNumber);
            } catch (rollbackError) {
                console.error(
                    "ROLLBACK FAILED for order " + order.orderNumber + ":",
                    rollbackError.message
                );
            }
        }

        return failOrder(
            res,
            saved ? "send email" : "save order",
            error
        );
    }

    console.log("New order saved and emailed:", order.orderNumber);

    send(res, 201, order);
}

function failOrder(res, stage, error) {

    console.error("ORDER FAILED (" + stage + "):", error.message);

    send(res, 503, {
        message:
            "We could not process your order right now. " +
            "Please check your connection and try again."
    });
}

// ---------- admin ----------

async function listOrders(req, res) {

    if (!requireAdmin(req, res)) {
        return;
    }

    const rows = await db(
        "GET",
        "orders?select=*&order=created_at.desc&limit=500"
    );

    send(res, 200, rows.map(rowToOrder));
}

async function addMenuItem(req, res) {

    if (!requireAdmin(req, res)) {
        return;
    }

    const newItem = await readJSONBody(req);

    const name = String(newItem.name || "").trim();
    const price = Number(newItem.price);
    const category = String(newItem.category || "").trim();

    if (!name || !(price > 0) || !category) {
        throw httpError(400, "Name, price and category are required");
    }

    const row = {
        name: name,
        price: price,
        category: category,
        image: String(newItem.image || ""),
        description: String(newItem.description || "")
    };

    try {
        await db("POST", "menu_items", row, "return=minimal");
    } catch (error) {

        if (isDuplicateError(error)) {
            throw httpError(409, "A menu item with that name already exists");
        }

        throw error;
    }

    send(res, 201, {
        message: "Menu item added successfully",
        item: row
    });
}

async function updateMenuItem(req, res, oldName) {

    if (!requireAdmin(req, res)) {
        return;
    }

    const updated = await readJSONBody(req);

    // Only these fields can be changed.

    const changes = {};

    if (updated.name !== undefined) {
        const name = String(updated.name).trim();
        if (!name) {
            throw httpError(400, "Name cannot be empty");
        }
        changes.name = name;
    }

    if (updated.price !== undefined) {
        const price = Number(updated.price);
        if (!(price > 0)) {
            throw httpError(400, "Price must be a positive number");
        }
        changes.price = price;
    }

    if (updated.category !== undefined) {
        const category = String(updated.category).trim();
        if (!category) {
            throw httpError(400, "Category cannot be empty");
        }
        changes.category = category;
    }

    if (updated.image !== undefined) {
        changes.image = String(updated.image);
    }

    if (updated.description !== undefined) {
        changes.description = String(updated.description);
    }

    if (Object.keys(changes).length === 0) {
        throw httpError(400, "Nothing to update");
    }

    let rows;

    try {
        rows = await db(
            "PATCH",
            "menu_items?select=" + MENU_COLUMNS +
            "&name_lower=eq." + enc(oldName.toLowerCase()),
            changes,
            "return=representation"
        );
    } catch (error) {

        if (isDuplicateError(error)) {
            throw httpError(409, "A menu item with that name already exists");
        }

        throw error;
    }

    if (!rows.length) {
        throw httpError(404, "Menu item not found");
    }

    send(res, 200, {
        message: "Menu item updated successfully",
        item: cleanMenuRow(rows[0])
    });
}

async function deleteMenuItem(req, res, itemName) {

    if (!requireAdmin(req, res)) {
        return;
    }

    const rows = await db(
        "DELETE",
        "menu_items?select=name&name_lower=eq." + enc(itemName.toLowerCase()),
        undefined,
        "return=representation"
    );

    if (!rows.length) {
        throw httpError(404, "Menu item not found");
    }

    send(res, 200, { message: "Menu item deleted successfully" });
}

// ---------- router ----------

async function route(req, res) {

    const url = req.url.split("?")[0];
    const method = req.method;

    // Create order (public)
    if (method === "POST" && url === "/api/orders") {
        return createOrder(req, res);
    }

    // Admin: check password
    if (method === "GET" && url === "/api/admin/check") {

        if (!requireAdmin(req, res)) {
            return;
        }

        return send(res, 200, { message: "OK" });
    }

    // Admin: list orders
    if (method === "GET" && url === "/api/orders") {
        return listOrders(req, res);
    }

    // Public: whole menu
    if (method === "GET" && url === "/") {
        return send(res, 200, await readMenu());
    }

    // Public: status
    if (method === "GET" && url === "/status") {
        return send(res, 200, {
            status: "online",
            message: "Bean & Brew backend is running"
        });
    }

    // Public: one menu item
    if (method === "GET" && url.startsWith("/menu/")) {

        const item = await findMenuItem(
            safeDecode(url.replace("/menu/", ""))
        );

        if (!item) {
            throw httpError(404, "Menu item not found");
        }

        return send(res, 200, item);
    }

    // Admin: add menu item
    if (method === "POST" && url === "/menu") {
        return addMenuItem(req, res);
    }

    // Admin: edit menu item
    if (method === "PUT" && url.startsWith("/menu/")) {
        return updateMenuItem(
            req,
            res,
            safeDecode(url.replace("/menu/", ""))
        );
    }

    // Admin: delete menu item
    if (method === "DELETE" && url.startsWith("/menu/")) {
        return deleteMenuItem(
            req,
            res,
            safeDecode(url.replace("/menu/", ""))
        );
    }

    throw httpError(404, "Route not found");
}

// =========================
// CREATE SERVER
// =========================

const server = http.createServer(function (req, res) {

    // ---------- CORS ----------

    const origin = req.headers.origin;

    if (origin && isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, x-admin-password"
    );

    res.setHeader("Content-Type", "application/json");

    res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
    );

    // Browser preflight. Must stay above every admin check.

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    route(req, res).catch(function (error) {

        if (res.headersSent) {
            return;
        }

        if (error.isHttpError) {
            return send(res, error.status, { message: error.message });
        }

        console.error("Server error on " + req.method + " " + req.url + ":", error.message);

        send(res, 500, { message: "Something went wrong. Please try again." });
    });
});

// =========================
// START SERVER
// =========================

server.listen(PORT, function () {

    console.log("Bean & Brew backend running on http://localhost:" + PORT);

    const missing = [];

    if (!SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!SUPABASE_KEY) missing.push("SUPABASE_SERVICE_KEY");
    if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
    if (!OWNER_EMAIL) missing.push("OWNER_EMAIL");
    if (!process.env.ADMIN_PASSWORD) missing.push("ADMIN_PASSWORD");

    if (missing.length) {
        console.log(
            "WARNING: these settings are missing, so parts of the site will not work: " +
            missing.join(", ")
        );
    }
});