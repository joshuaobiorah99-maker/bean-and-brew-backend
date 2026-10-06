require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const PORT = process.env.PORT || 3000;

// =========================
// EMAIL
// =========================

// The timeouts make a lost connection fail within ~10 seconds
// instead of hanging for minutes.

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
});

function buildOrderEmail(order) {

    const lines = order.items.map(function(item) {
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

    // If ADMIN_PASSWORD is missing from .env, nobody gets in.
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

        res.writeHead(429);

        res.end(JSON.stringify({
            message: "Too many wrong attempts. Try again in 15 minutes."
        }));

        return false;
    }

    if (passwordMatches(req.headers["x-admin-password"])) {
        return true;
    }

    recordFailure(ip);

    res.writeHead(401);

    res.end(JSON.stringify({
        message: "Unauthorized"
    }));

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
// FILES
// =========================

const menuFile = path.join(__dirname, "menu-data.json");
const ordersFile = path.join(__dirname, "orders.json");

// =========================
// MENU FUNCTIONS
// =========================

function readMenu() {
    return JSON.parse(fs.readFileSync(menuFile, "utf8"));
}

function saveMenu(menuItems) {
    fs.writeFileSync(
        menuFile,
        JSON.stringify(menuItems, null, 4)
    );
}

// =========================
// ORDER FUNCTIONS
// =========================

function readOrders() {
    if (!fs.existsSync(ordersFile)) {
        return [];
    }

    return JSON.parse(fs.readFileSync(ordersFile, "utf8"));
}

function saveOrders(orders) {
    fs.writeFileSync(
        ordersFile,
        JSON.stringify(orders, null, 4)
    );
}

// =========================
// READ REQUEST BODY (max 100 KB)
// =========================

function readBody(req, res, onDone) {

    let body = "";
    let tooLarge = false;

    req.on("data", function(chunk) {

        if (tooLarge) {
            return;
        }

        body += chunk;

        if (body.length > 100000) {

            tooLarge = true;

            res.writeHead(413);

            res.end(JSON.stringify({
                message: "Request too large"
            }));
        }
    });

    req.on("end", function() {
        if (!tooLarge) {
            onDone(body);
        }
    });
}

// =========================
// CREATE SERVER
// =========================

const server = http.createServer(function(req, res) {

    // =========================
    // CORS HEADERS
    // =========================

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

    res.setHeader(
        "Content-Type",
        "application/json"
    );

    res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
    );

    // =========================
    // OPTIONS (browser preflight)
    // Must stay ABOVE every admin check.
    // =========================

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // =====================================================
    // CREATE ORDER (public, customers use this)
    // POST /api/orders
    // =====================================================

    if (req.method === "POST" && req.url === "/api/orders") {

        readBody(req, res, function(body) {

            try {

                const orderData = JSON.parse(body);

                const customer = orderData.customer || {};
                const submittedItems = orderData.items || {};

                const name = String(
                    customer.name || ""
                ).trim();

                const phone = String(
                    customer.phone || ""
                ).trim();

                const orderType = String(
                    customer.orderType || ""
                ).trim();

                const note = String(
                    customer.note || ""
                ).trim();

                // =========================
                // VALIDATE CUSTOMER
                // =========================

                if (
                    !name ||
                    !phone ||
                    !["Pickup", "Delivery"].includes(orderType)
                ) {

                    res.writeHead(400);

                    res.end(JSON.stringify({
                        message: "Please complete the customer details."
                    }));

                    return;
                }

                // =========================
                // READ MENU
                // =========================

                const menuItems = readMenu();

                // =========================
                // VALIDATE ORDER ITEMS
                // (prices always come from the menu file,
                // never from the browser)
                // =========================

                const items = Object.entries(submittedItems)

                    .map(function([itemName, item]) {

                        const menuItem = menuItems.find(
                            function(product) {
                                return product.name === itemName;
                            }
                        );

                        const quantity = Number(item.quantity);

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

                // =========================
                // CHECK EMPTY ORDER
                // =========================

                if (items.length === 0) {

                    res.writeHead(400);

                    res.end(JSON.stringify({
                        message: "Your order is empty."
                    }));

                    return;
                }

                // =========================
                // CALCULATE TOTAL
                // =========================

                const total = items.reduce(
                    function(sum, item) {
                        return sum + (
                            item.price * item.quantity
                        );
                    },
                    0
                );

                // =========================
                // CREATE ORDER
                // =========================

                const order = {

                    orderNumber:
                        `BB${Math.floor(
                            100000 +
                            Math.random() * 900000
                        )}`,

                    createdAt:
                        new Date().toISOString(),

                    customer: {
                        name,
                        phone,
                        orderType,
                        note
                    },

                    items,

                    total
                };

                // =========================
                // EMAIL THE OWNER FIRST
                // If the email cannot be sent (no internet,
                // Gmail down), the order is NOT saved and the
                // customer sees an error instead of a false
                // "order placed" message.
                // =========================

                transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: process.env.OWNER_EMAIL || process.env.EMAIL_USER,
                    subject: "New Bean & Brew order " + order.orderNumber,
                    text: buildOrderEmail(order)
                }, function(error, info) {

                    if (error) {

                        console.log(
                            "EMAIL ERROR - order rejected:",
                            error.message
                        );

                        res.writeHead(503);

                        res.end(JSON.stringify({
                            message:
                                "We could not process your order right now. " +
                                "Please check your connection and try again."
                        }));

                        return;
                    }

                    console.log("Email sent:", info.response);

                    // =========================
                    // SAVE ORDER (only after the email went out)
                    // =========================

                    try {

                        const orders = readOrders();

                        orders.push(order);

                        saveOrders(orders);

                        console.log(
                            "New order saved:",
                            order.orderNumber
                        );

                        res.writeHead(201);

                        res.end(
                            JSON.stringify(order)
                        );

                    } catch (saveError) {

                        console.error(
                            "Order save failed:",
                            saveError
                        );

                        res.writeHead(500);

                        res.end(JSON.stringify({
                            message: "Could not save the order."
                        }));
                    }
                });

            } catch (error) {

                console.error(
                    "Order save failed:",
                    error
                );

                res.writeHead(400);

                res.end(JSON.stringify({
                    message: "Could not save the order."
                }));
            }
        });

        return;
    }

    // =====================================================
    // ADMIN: CHECK PASSWORD
    // GET /api/admin/check
    // Used by admin.js to verify the password right away.
    // =====================================================

    if (
        req.method === "GET" &&
        req.url === "/api/admin/check"
    ) {

        if (!requireAdmin(req, res)) {
            return;
        }

        res.writeHead(200);

        res.end(JSON.stringify({
            message: "OK"
        }));

        return;
    }

    // =====================================================
    // ADMIN: GET ALL ORDERS
    // GET /api/orders
    // =====================================================

    if (
        req.method === "GET" &&
        req.url.split("?")[0] === "/api/orders"
    ) {

        if (!requireAdmin(req, res)) {
            return;
        }

        try {

            res.writeHead(200);

            res.end(
                JSON.stringify(readOrders())
            );

        } catch (error) {

            res.writeHead(500);

            res.end(JSON.stringify({
                message: "Could not load orders"
            }));
        }

        return;
    }

    // =====================================================
    // GET ALL MENU ITEMS (public)
    // GET /
    // =====================================================

    if (
        req.method === "GET" &&
        req.url.split("?")[0] === "/"
    ) {

        try {

            const menuItems = readMenu();

            res.writeHead(200);

            res.end(
                JSON.stringify(menuItems)
            );

        } catch (error) {

            res.writeHead(500);

            res.end(JSON.stringify({
                message: "Could not load menu",
                error: error.message
            }));
        }

        return;
    }

    // =====================================================
    // GET SERVER STATUS (public)
    // GET /status
    // =====================================================

    if (
        req.method === "GET" &&
        req.url === "/status"
    ) {

        res.writeHead(200);

        res.end(JSON.stringify({
            status: "online",
            message: "Bean & Brew backend is running"
        }));

        return;
    }

    // =====================================================
    // GET ONE MENU ITEM (public)
    // GET /menu/:name
    // =====================================================

    if (
        req.method === "GET" &&
        req.url.startsWith("/menu/")
    ) {

        try {

            const menuItems = readMenu();

            const itemName = decodeURIComponent(
                req.url.split("?")[0].replace("/menu/", "")
            );

            const item = menuItems.find(
                function(item) {
                    return (
                        item.name.toLowerCase() ===
                        itemName.toLowerCase()
                    );
                }
            );

            if (!item) {

                res.writeHead(404);

                res.end(JSON.stringify({
                    message: "Menu item not found"
                }));

                return;
            }

            res.writeHead(200);

            res.end(
                JSON.stringify(item)
            );

        } catch (error) {

            res.writeHead(500);

            res.end(JSON.stringify({
                message: "Could not load menu item",
                error: error.message
            }));
        }

        return;
    }

    // =====================================================
    // ADMIN: ADD MENU ITEM
    // POST /menu
    // =====================================================

    if (
        req.method === "POST" &&
        req.url === "/menu"
    ) {

        if (!requireAdmin(req, res)) {
            return;
        }

        readBody(req, res, function(body) {

            try {

                const newItem = JSON.parse(body);

                if (
                    !newItem.name ||
                    !newItem.price ||
                    !newItem.category
                ) {

                    res.writeHead(400);

                    res.end(JSON.stringify({
                        message:
                            "Name, price and category are required"
                    }));

                    return;
                }

                newItem.name = String(newItem.name).trim();

                const menuItems = readMenu();

                const alreadyExists = menuItems.some(
                    function(item) {
                        return (
                            item.name.toLowerCase() ===
                            newItem.name.toLowerCase()
                        );
                    }
                );

                if (alreadyExists) {

                    res.writeHead(409);

                    res.end(JSON.stringify({
                        message:
                            "A menu item with that name already exists"
                    }));

                    return;
                }

                menuItems.push(newItem);

                saveMenu(menuItems);

                res.writeHead(201);

                res.end(JSON.stringify({
                    message:
                        "Menu item added successfully",

                    item: newItem
                }));

            } catch (error) {

                res.writeHead(400);

                res.end(JSON.stringify({
                    message: "Invalid menu data",
                    error: error.message
                }));
            }
        });

        return;
    }

    // =====================================================
    // ADMIN: EDIT MENU ITEM
    // PUT /menu/:name
    // =====================================================

    if (
        req.method === "PUT" &&
        req.url.startsWith("/menu/")
    ) {

        if (!requireAdmin(req, res)) {
            return;
        }

        readBody(req, res, function(body) {

            try {

                const oldName = decodeURIComponent(
                    req.url.replace("/menu/", "")
                );

                const updatedItem = JSON.parse(body);

                const menuItems = readMenu();

                const index = menuItems.findIndex(
                    function(item) {
                        return (
                            item.name.toLowerCase() ===
                            oldName.toLowerCase()
                        );
                    }
                );

                if (index === -1) {

                    res.writeHead(404);

                    res.end(JSON.stringify({
                        message: "Menu item not found"
                    }));

                    return;
                }

                menuItems[index] = {
                    ...menuItems[index],
                    ...updatedItem
                };

                saveMenu(menuItems);

                res.writeHead(200);

                res.end(JSON.stringify({
                    message:
                        "Menu item updated successfully",

                    item: menuItems[index]
                }));

            } catch (error) {

                res.writeHead(400);

                res.end(JSON.stringify({
                    message:
                        "Could not update menu item",

                    error: error.message
                }));
            }
        });

        return;
    }

    // =====================================================
    // ADMIN: DELETE MENU ITEM
    // DELETE /menu/:name
    // =====================================================

    if (
        req.method === "DELETE" &&
        req.url.startsWith("/menu/")
    ) {

        if (!requireAdmin(req, res)) {
            return;
        }

        try {

            const menuItems = readMenu();

            const itemName = decodeURIComponent(
                req.url.replace("/menu/", "")
            );

            const newMenuItems = menuItems.filter(
                function(item) {
                    return (
                        item.name.toLowerCase() !==
                        itemName.toLowerCase()
                    );
                }
            );

            if (
                newMenuItems.length ===
                menuItems.length
            ) {

                res.writeHead(404);

                res.end(JSON.stringify({
                    message: "Menu item not found"
                }));

                return;
            }

            saveMenu(newMenuItems);

            res.writeHead(200);

            res.end(JSON.stringify({
                message:
                    "Menu item deleted successfully"
            }));

        } catch (error) {

            res.writeHead(500);

            res.end(JSON.stringify({
                message:
                    "Could not delete menu item",

                error: error.message
            }));
        }

        return;
    }

    // =====================================================
    // UNKNOWN ROUTE
    // =====================================================

    res.writeHead(404);

    res.end(JSON.stringify({
        message: "Route not found"
    }));
});

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, function() {

    console.log(
        "Bean & Brew backend running on http://localhost:" +
        PORT
    );

    if (!process.env.ADMIN_PASSWORD) {
        console.log(
            "WARNING: ADMIN_PASSWORD is not set. " +
            "Admin actions are locked until you add it to .env"
        );
    }
});