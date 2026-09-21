const http = require("http");

// ===== PASSWORD HASHING =====

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");

        crypto.scrypt(
            password,
            salt,
            64,
            {
                N: 16384,
                r: 8,
                p: 1
            },
            (err, derivedKey) => {
                if (err) return reject(err);

                resolve({
                    salt,
                    hash: derivedKey.toString("hex")
                });
            }
        );
    });
}

function verifyPassword(password, salt, storedHash) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            password,
            salt,
            64,
            {
                N: 16384,
                r: 8,
                p: 1
            },
            (err, derivedKey) => {
                if (err) return reject(err);

                const stored = Buffer.from(storedHash, "hex");
                const supplied = Buffer.from(derivedKey.toString("hex"), "hex");

                if (stored.length !== supplied.length) {
                    return resolve(false);
                }

                resolve(crypto.timingSafeEqual(stored, supplied));
            }
        );
    });
}

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const DOWNLOAD_DIR = path.join(__dirname, "downloads");

function loadEnv() {

    const file =
        path.join(__dirname, ".env");

    if (!fs.existsSync(file))
        return;

    for (
        const line of
        fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
    ) {

        const x = line.trim();

        if (
            !x ||
            x.startsWith("#") ||
            !x.includes("=")
        )
            continue;

        const i = x.indexOf("=");

        const key =
            x.slice(0, i).trim();

        const value =
            x.slice(i + 1).trim();

        if (
            process.env[key] === undefined
        ) {
            process.env[key] = value;
        }
    }
}

loadEnv();

const PORT =
    Number(
        process.env.PORT || 3000
    );

const STORE_URL =
    process.env.STORE_URL ||
    `http://localhost:${PORT}`;

const ACCESS_TOKEN =
    process.env.MERCADOPAGO_ACCESS_TOKEN ||
    "";

const PIX_KEY =
    process.env.PIX_KEY || "";


const PRODUCT = {
    id: "creator-pack",
    title: "NEXORA Creator Pack",
    price: 19.90,
    currency: "BRL"
};

const DOWNLOAD_FILE =
    path.join(
        DOWNLOAD_DIR,
        "Creator-Pack-v1.zip"
    );

/* ============================================================
   DATABASE
============================================================ */

function ensureDB() {

    fs.mkdirSync(
        DATA_DIR,
        { recursive: true }
    );

    fs.mkdirSync(
        DOWNLOAD_DIR,
        { recursive: true }
    );

    if (
        !fs.existsSync(
            ORDERS_FILE
        )
    ) {

        fs.writeFileSync(
            ORDERS_FILE,
            "[]"
        );
    }
}

function orders() {

    ensureDB();

    try {

        const data =
            JSON.parse(
                fs.readFileSync(
                    ORDERS_FILE,
                    "utf8"
                )
            );

        return Array.isArray(data)
            ? data
            : [];

    } catch {

        return [];
    }
}

function saveOrders(data) {

    fs.writeFileSync(
        ORDERS_FILE,
        JSON.stringify(
            data,
            null,
            2
        )
    );
}

function findOrder(id) {

    return orders().find(
        x => x.id === id
    );
}

/* ============================================================
   RESPONSE
============================================================ */

function sendJSON(
    res,
    status,
    data
) {

    const body =
        JSON.stringify(
            data,
            null,
            2
        );

    res.writeHead(
        status,
        {
            "Content-Type":
                "application/json; charset=utf-8",

            "Cache-Control":
                "no-store"
        }
    );

    res.end(body);
}

function readBody(req) {

    return new Promise(
        (resolve, reject) => {

            let body = "";

            req.on(
                "data",
                chunk => {

                    body += chunk;

                    if (
                        body.length >
                        1024 * 1024
                    ) {

                        reject(
                            new Error(
                                "Payload muito grande."
                            )
                        );

                        req.destroy();
                    }
                }
            );

            req.on(
                "end",
                () => {

                    if (!body) {
                        resolve({});
                        return;
                    }

                    try {

                        resolve(
                            JSON.parse(body)
                        );

                    } catch {

                        reject(
                            new Error(
                                "JSON inválido."
                            )
                        );
                    }
                }
            );

            req.on(
                "error",
                reject
            );
        }
    );
}

/* ============================================================
   CHECKOUT
============================================================ */

function newOrderID() {

    return (
        "NEX-" +
        Date.now() +
        "-" +
        crypto
            .randomBytes(5)
            .toString("hex")
    );
}

function validEmail(email) {

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(email);
}

async function createPreference(
    order
) {

    if (!ACCESS_TOKEN) {

        return {
            mode: "setup",
            orderId: order.id,
            message:
                "Mercado Pago ainda não configurado."
        };
    }

    const preference = {

        items: [
            {
                id:
                    PRODUCT.id,

                title:
                    PRODUCT.title,

                quantity: 1,

                currency_id:
                    PRODUCT.currency,

                unit_price:
                    PRODUCT.price
            }
        ],

        payer: {
            name:
                order.customer.name,

            email:
                order.customer.email
        },

        external_reference:
            order.id,

        back_urls: {

            success:
                `${STORE_URL}/checkout/?status=success`,

            failure:
                `${STORE_URL}/checkout/?status=failure`,

            pending:
                `${STORE_URL}/checkout/?status=pending`
        },

        auto_return:
            "approved",

        notification_url:
            `${STORE_URL}/api/webhook/mercadopago`
    };

    const response =
        await fetch(
            "https://api.mercadopago.com/checkout/preferences",
            {
                method: "POST",

                headers: {

                    Authorization:
                        `Bearer ${ACCESS_TOKEN}`,

                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(
                        preference
                    )
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            "Erro ao criar checkout."
        );
    }

    return {

        mode:
            "mercadopago",

        orderId:
            order.id,

        checkoutUrl:
            data.init_point,

        preferenceId:
            data.id
    };
}

async function createCheckout(
    req,
    res
) {

    try {

        const body =
            await readBody(req);

        const name =
            String(
                body.name || ""
            ).trim();

        const email =
            String(
                body.email || ""
            )
            .trim()
            .toLowerCase();

        if (
            name.length < 2 ||
            name.length > 100
        ) {

            return sendJSON(
                res,
                400,
                {
                    ok: false,
                    error:
                        "Nome inválido."
                }
            );
        }

        if (
            !validEmail(email)
        ) {

            return sendJSON(
                res,
                400,
                {
                    ok: false,
                    error:
                        "E-mail inválido."
                }
            );
        }

        const order = {

            id:
                newOrderID(),

            product:
                PRODUCT,

            customer: {
                name,
                email
            },

            status:
                "pending_payment",

            downloadUnlocked:
                false,

            createdAt:
                new Date()
                    .toISOString()
        };

        const data =
            orders();

        data.push(order);

        saveOrders(data);

        try {

            const checkout =
                await createPreference(
                    order
                );

            return sendJSON(
                res,
                200,
                {
                    ok: true,
                    ...checkout
                }
            );

        } catch (error) {

            return sendJSON(
                res,
                502,
                {
                    ok: false,
                    error:
                        error.message
                }
            );
        }

    } catch (error) {

        return sendJSON(
            res,
            500,
            {
                ok: false,
                error:
                    "Erro interno."
            }
        );
    }
}

/* ============================================================
   PAYMENT
============================================================ */

async function getPayment(
    paymentID
) {

    if (!ACCESS_TOKEN) {

        return {
            configured: false
        };
    }

    if (
        !/^\d+$/.test(
            String(paymentID)
        )
    ) {

        throw new Error(
            "ID inválido."
        );
    }

    const response =
        await fetch(
            `https://api.mercadopago.com/v1/payments/${paymentID}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${ACCESS_TOKEN}`
                }
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            "Pagamento não encontrado."
        );
    }

    return {

        configured:
            true,

        payment: {

            id:
                data.id,

            status:
                data.status,

            externalReference:
                data.external_reference,

            approvedAt:
                data.date_approved ||
                null
        }
    };
}

/* ============================================================
   WEBHOOK
============================================================ */

async function webhook(
    req,
    res
) {

    try {

        const body =
            await readBody(req);

        const paymentID =
            body?.data?.id
                ? String(body.data.id)
                : "";

        if (!paymentID) {

            return sendJSON(
                res,
                200,
                {
                    ok: true,
                    received: true
                }
            );
        }

        if (!ACCESS_TOKEN) {

            return sendJSON(
                res,
                200,
                {
                    ok: true,
                    mode: "setup"
                }
            );
        }

        const result =
            await getPayment(
                paymentID
            );

        if (
            !result.configured ||
            !result.payment
        ) {

            return sendJSON(
                res,
                502,
                {
                    ok: false
                }
            );
        }

        const reference =
            result.payment
                .externalReference;

        if (!reference) {

            return sendJSON(
                res,
                200,
                {
                    ok: true
                }
            );
        }

        const data =
            orders();

        const index =
            data.findIndex(
                x =>
                    x.id ===
                    reference
            );

        if (index === -1) {

            return sendJSON(
                res,
                200,
                {
                    ok: true
                }
            );
        }

        if (
            result.payment.status ===
            "approved"
        ) {

            data[index].status =
                "approved";

            data[index].paymentId =
                result.payment.id;

            data[index].approvedAt =
                result.payment.approvedAt;

            data[index].downloadUnlocked =
                true;

        } else {

            data[index].status =
                result.payment.status ||
                "unknown";

            data[index].downloadUnlocked =
                false;
        }

        saveOrders(data);

        return sendJSON(
            res,
            200,
            {
                ok: true,
                processed: true
            }
        );

    } catch (error) {

        console.error(
            "Webhook:",
            error
        );

        return sendJSON(
            res,
            500,
            {
                ok: false
            }
        );
    }
}

/* ============================================================
   DOWNLOAD PROTEGIDO
============================================================ */

function download(
    req,
    res,
    url
) {

    const orderID =
        url.searchParams.get(
            "order"
        );

    if (!orderID) {

        return sendJSON(
            res,
            400,
            {
                ok: false,
                error:
                    "Pedido não informado."
            }
        );
    }

    const order =
        findOrder(
            orderID
        );

    if (!order) {

        return sendJSON(
            res,
            404,
            {
                ok: false,
                error:
                    "Pedido não encontrado."
            }
        );
    }

    if (
        order.status !==
            "approved" ||
        order.downloadUnlocked !==
            true
    ) {

        return sendJSON(
            res,
            403,
            {
                ok: false,
                error:
                    "Download ainda não liberado."
            }
        );
    }

    if (
        !fs.existsSync(
            DOWNLOAD_FILE
        )
    ) {

        return sendJSON(
            res,
            404,
            {
                ok: false,
                error:
                    "Produto não encontrado."
            }
        );
    }

    const stat =
        fs.statSync(
            DOWNLOAD_FILE
        );

    res.writeHead(
        200,
        {
            "Content-Type":
                "application/zip",

            "Content-Length":
                stat.size,

            "Content-Disposition":
                'attachment; filename="Creator-Pack-v1.zip"',

            "Cache-Control":
                "no-store"
        }
    );

    fs.createReadStream(
        DOWNLOAD_FILE
    ).pipe(res);
}

/* ============================================================
   STATIC FILES
============================================================ */

function mime(file) {

    const ext =
        path.extname(
            file
        ).toLowerCase();

    const map = {

        ".html":
            "text/html; charset=utf-8",

        ".css":
            "text/css; charset=utf-8",

        ".js":
            "application/javascript; charset=utf-8",

        ".json":
            "application/json; charset=utf-8",

        ".png":
            "image/png",

        ".jpg":
            "image/jpeg",

        ".jpeg":
            "image/jpeg",

        ".webp":
            "image/webp",

        ".svg":
            "image/svg+xml"
    };

    return (
        map[ext] ||
        "application/octet-stream"
    );
}
function getProducts(res){

    const file =
    path.join(
        DATA_DIR,
        "products.json"
    );

    const products =
    JSON.parse(
        fs.readFileSync(
            file,
            "utf8"
        )
    );

    return sendJSON(
        res,
        200,
        products
    );
}
function staticFile(
    req,
    res,
    url
) {

    let pathname =
        decodeURIComponent(
            url.pathname
        );

    if (
        pathname === "/" ||
        pathname === ""
    ) {

        pathname =
            "/index.html";
    }

    let file =
        path.resolve(
            ROOT,
            "." + pathname
        );

    if (
        !file.startsWith(
            ROOT + path.sep
        )
    ) {

        return sendJSON(
            res,
            403,
            {
                ok: false
            }
        );
    }

    if (
        fs.existsSync(file) &&
        fs.statSync(file).isDirectory()
    ) {

        file =
            path.join(
                file,
                "index.html"
            );
    }

    if (
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
    ) {

        return sendJSON(
            res,
            404,
            {
                ok: false,
                error:
                    "Página não encontrada."
            }
        );
    }

    const data =
        fs.readFileSync(
            file
        );

    res.writeHead(
        200,
        {
            "Content-Type":
                mime(file)
        }
    );

    res.end(data);
}


/* ============================================================
   NEXORA PIX
============================================================ */

function pixCRC16(str) {

    let crc = 0xFFFF;

    for (let i = 0; i < str.length; i++) {

        crc ^= str.charCodeAt(i) << 8;

        for (let j = 0; j < 8; j++) {

            if (crc & 0x8000) {
                crc =
                    ((crc << 1) ^ 0x1021) &
                    0xFFFF;
            } else {
                crc =
                    (crc << 1) &
                    0xFFFF;
            }
        }
    }

    return crc
        .toString(16)
        .toUpperCase()
        .padStart(4, "0");
}

function pixField(id, value) {

    const valueString = String(value);

    return (
        String(id).padStart(2, "0") +
        String(valueString.length).padStart(2, "0") +
        valueString
    );
}

function createPixPayload({
    key,
    amount,
    txid
}) {

    const merchantName =
        "NEXORA";

    const merchantCity =
        "SAO PAULO";

    const merchantAccount =
        pixField(
            26,
            pixField(
                00,
                "BR.GOV.BCB.PIX"
            ) +
            pixField(
                01,
                key
            )
        );

    const cleanTxid =
        String(txid)
            .replace(
                /[^A-Za-z0-9]/g,
                ""
            )
            .substring(0, 25) || "***";

    let payload =
        pixField(00, "01") +
        merchantAccount +
        pixField(52, "0000") +
        pixField(53, "986") +
        pixField(
            54,
            Number(amount).toFixed(2)
        ) +
        pixField(58, "BR") +
        pixField(
            59,
            merchantName
        ) +
        pixField(
            60,
            merchantCity
        ) +
        pixField(
            62,
            pixField(
                05,
                cleanTxid
            )
        ) +
        "6304";

    return (
        payload +
        pixCRC16(payload)
    );
}


/* ============================================================
   SERVER
============================================================ */

ensureDB();

const server =
    http.createServer(
        async (
            req,
            res
        ) => {

            try {

                const url =
                    new URL(
                        req.url,
                        `http://${req.headers.host || "localhost"}`
                    );

                const route =
                    url.pathname;

                if (
                    req.method === "GET" &&
                    route === "/api/products"
                ) {
                    try {
                        const productsFile = path.join(
                            DATA_DIR,
                            "products.json"
                        );

                        const products = JSON.parse(
                            fs.readFileSync(
                                productsFile,
                                "utf8"
                            )
                        );

                        return sendJSON(res, 200, {
                            ok: true,
                            products
                        });
                    } catch (error) {
                        console.error(
                            "Erro ao carregar produtos:",
                            error
                        );

                        return sendJSON(res, 500, {
                            ok: false,
                            message: "Não foi possível carregar os produtos."
                        });
                    }
                }


                if (
                    req.method === "POST" &&
                    route === "/api/create-pix"
                ) {

                    try {

                        if (!PIX_KEY) {

                            return sendJSON(
                                res,
                                500,
                                {
                                    ok: false,
                                    message:
                                        "Pix não está configurado no servidor."
                                }
                            );
                        }

                        const body =
                            await readBody(req);

                        const nome =
                            String(
                                body.nome || ""
                            ).trim();

                        const email =
                            String(
                                body.email || ""
                            ).trim()
                            .toLowerCase();

                        if (!nome || !email) {

                            return sendJSON(
                                res,
                                400,
                                {
                                    ok: false,
                                    message:
                                        "Nome e e-mail são obrigatórios."
                                }
                            );
                        }

                        if (!validEmail(email)) {

                            return sendJSON(
                                res,
                                400,
                                {
                                    ok: false,
                                    message:
                                        "E-mail inválido."
                                }
                            );
                        }

                        const order = {

                            id:
                                newOrderID(),

                            product: {
                                id:
                                    PRODUCT.id,

                                name:
                                    PRODUCT.title,

                                price:
                                    PRODUCT.price,

                                currency:
                                    PRODUCT.currency
                            },

                            customer: {
                                name:
                                    nome,

                                email:
                                    email
                            },

                            status:
                                "pending_payment",

                            paymentMethod:
                                "pix",

                            downloadUnlocked:
                                false,

                            createdAt:
                                new Date()
                                    .toISOString()
                        };

                        const currentOrders =
                            orders();

                        currentOrders.push(
                            order
                        );

                        saveOrders(
                            currentOrders
                        );

                        const pix =
                            createPixPayload({
                                key:
                                    PIX_KEY,

                                amount:
                                    PRODUCT.price,

                                txid:
                                    order.id
                            });

                        const QRCode =
                            require("qrcode");

                        const qrCode =
                            await QRCode.toDataURL(
                                pix,
                                {
                                    errorCorrectionLevel:
                                        "M",

                                    margin:
                                        2,

                                    width:
                                        420
                                }
                            );

                        return sendJSON(
                            res,
                            200,
                            {
                                ok:
                                    true,

                                mode:
                                    "pix",

                                orderId:
                                    order.id,

                                amount:
                                    PRODUCT.price,

                                pix:
                                    pix,

                                qrCode:
                                    qrCode
                            }
                        );

                    } catch (error) {

                        console.error(
                            "Erro ao criar Pix:",
                            error
                        );

                        return sendJSON(
                            res,
                            500,
                            {
                                ok:
                                    false,

                                message:
                                    "Não foi possível gerar o Pix."
                            }
                        );
                    }
                }

                if (
                    req.method === "GET" &&
                    route === "/api/health"
                ) {

                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true,

                            service:
                                "NEXORA",

                            payment:
                                ACCESS_TOKEN
                                    ? "configured"
                                    : "not_configured",

                            database:
                                "ready",

                            product:
                                fs.existsSync(
                                    DOWNLOAD_FILE
                                )
                                    ? "ready"
                                    : "missing"
                        }
                    );
                }

                if (
                    req.method === "POST" &&
                    route ===
                    "/api/create-checkout"
                ) {

                    return createCheckout(
                        req,
                        res
                    );
                }

                if (
                    req.method === "POST" &&
                    route ===
                    "/api/webhook/mercadopago"
                ) {

                    return webhook(
                        req,
                        res
                    );
                }

                if (
                    req.method === "GET" &&
                    route ===
                    "/api/download"
                ) {

                    return download(
                        req,
                        res,
                        url
                    );
                }

                if (
                    req.method === "GET" &&
                    route ===
                    "/api/order"
                ) {

                    const id =
                        url.searchParams.get(
                            "id"
                        );

                    const order =
                        findOrder(id);

                    if (!order) {

                        return sendJSON(
                            res,
                            404,
                            {
                                ok: false
                            }
                        );
                    }

                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            order
                        }
                    );
                }


                if (
                    req.method === "POST" &&
                    url.pathname === "/api/register"
                ) {

                    const body = await readBody(req);

                    const USERS_FILE =
                        path.join(
                            DATA_DIR,
                            "users.json"
                        );

                    let users = [];

                    if (fs.existsSync(USERS_FILE)) {
                        users = JSON.parse(
                            fs.readFileSync(
                                USERS_FILE,
                                "utf8"
                            )
                        );
                    }

                    const passwordData = await hashPassword(body.senha);

    const user = {
        id: crypto.randomUUID(),
        nome: body.nome,
        email: body.email,
        senhaHash: passwordData.hash,
        senhaSalt: passwordData.salt,
        criado: new Date().toISOString()
    };

                    users.push(user);

                    fs.writeFileSync(
                        USERS_FILE,
                        JSON.stringify(
                            users,
                            null,
                            2
                        )
                    );

                    return sendJSON(
                        res,
                        200,
                        {
                            ok:true,
                            message:"Conta criada!"
                        }
                    );
                }

                if (
                    req.method === "GET"
                ) {

                    return staticFile(
                        req,
                        res,
                        url
                    );
                }

                return sendJSON(
                    res,
                    405,
                    {
                        ok: false
                    }
                );

            } catch (error) {

                console.error(
                    error
                );

                return sendJSON(
                    res,
                    500,
                    {
                        ok: false,
                        error:
                            "Erro interno."
                    }
                );
            }
        }
    );

server.listen(
    PORT,
    () => {

        console.log("");
        console.log(
            "================================="
        );
        console.log(
            "       NEXORA ONLINE"
        );
        console.log(
            "================================="
        );
        console.log(
            `URL: ${STORE_URL}`
        );
        console.log(
            `Pagamento: ${
                ACCESS_TOKEN
                    ? "CONFIGURADO"
                    : "AGUARDANDO CONFIGURAÇÃO"
            }`
        );
        console.log(
            `Produto: ${
                fs.existsSync(
                    DOWNLOAD_FILE
                )
                    ? "OK"
                    : "NÃO ENCONTRADO"
            }`
        );
        console.log(
            "================================="
        );
        console.log("");
    }
);
