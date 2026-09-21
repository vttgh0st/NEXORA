const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const STORE_URL = process.env.STORE_URL || `http://localhost:${PORT}`;

const ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN || "";
const WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET || "";

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

const PRODUCT = {
    id: "creator-pack",
    title: "NEXORA Creator Pack",
    price: 19.90,
    currency: "BRL"
};


/* ================================
   BANCO DE PEDIDOS
================================ */

function ensureDatabase() {

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, {
            recursive: true
        });
    }

    if (!fs.existsSync(ORDERS_FILE)) {
        fs.writeFileSync(
            ORDERS_FILE,
            "[]",
            "utf8"
        );
    }
}

function readOrders() {

    ensureDatabase();

    try {

        const data =
            fs.readFileSync(
                ORDERS_FILE,
                "utf8"
            );

        return JSON.parse(data);

    } catch {

        return [];
    }
}

function saveOrders(orders) {

    ensureDatabase();

    fs.writeFileSync(
        ORDERS_FILE,
        JSON.stringify(
            orders,
            null,
            2
        ),
        "utf8"
    );
}

function saveOrder(order) {

    const orders = readOrders();

    orders.push(order);

    saveOrders(orders);

    return order;
}

function findOrder(id) {

    const orders = readOrders();

    return orders.find(
        order => order.id === id
    );
}


/* ================================
   UTILIDADES
================================ */

function json(res, status, data) {

    const body =
        JSON.stringify(
            data,
            null,
            2
        );

    res.writeHead(status, {
        "Content-Type":
            "application/json; charset=utf-8",

        "Content-Length":
            Buffer.byteLength(body)
    });

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


function generateOrderId() {

    return (
        "NEX-" +
        Date.now()
            .toString(36)
            .toUpperCase() +
        "-" +
        crypto
            .randomBytes(3)
            .toString("hex")
            .toUpperCase()
    );
}


function validEmail(email) {

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(email);
}


/* ================================
   MERCADO PAGO
================================ */

async function createMercadoPagoPreference(order) {

    if (!ACCESS_TOKEN) {

        return {
            mode: "setup",
            order
        };
    }

    const preference = {

        items: [
            {
                id: PRODUCT.id,
                title: PRODUCT.title,
                quantity: 1,
                currency_id: PRODUCT.currency,
                unit_price: PRODUCT.price
            }
        ],

        payer: {
            name: order.customer.name,
            email: order.customer.email
        },

        external_reference: order.id,

        back_urls: {

            success:
                `${STORE_URL}/checkout/?status=success`,

            failure:
                `${STORE_URL}/checkout/?status=failure`,

            pending:
                `${STORE_URL}/checkout/?status=pending`
        },

        auto_return: "approved"
    };


    const response = await fetch(
        "https://api.mercadopago.com/checkout/preferences",
        {

            method: "POST",

            headers: {

                "Authorization":
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

        console.error(
            "Mercado Pago:",
            response.status,
            data
        );

        throw new Error(
            "Mercado Pago recusou o checkout."
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


/* ================================
   CRIAR PEDIDO
================================ */

async function handleCreateCheckout(
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
            ).trim();


        if (name.length < 2) {

            return json(
                res,
                400,
                {
                    ok: false,
                    error:
                        "Nome inválido."
                }
            );
        }


        if (!validEmail(email)) {

            return json(
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
                generateOrderId(),

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


        /*
         * O pedido é salvo ANTES
         * de tentar criar o checkout.
         */

        saveOrder(order);


        try {

            const payment =
                await createMercadoPagoPreference(
                    order
                );

            return json(
                res,
                200,
                {
                    ok: true,
                    ...payment
                }
            );

        } catch (paymentError) {

            console.error(
                paymentError
            );

            return json(
                res,
                502,
                {
                    ok: false,
                    error:
                        "Pedido criado, mas não foi possível criar o checkout."
                }
            );
        }


    } catch (error) {

        console.error(
            error
        );

        return json(
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


/* ================================
   CONSULTAR PEDIDO
================================ */

function handleOrderStatus(
    req,
    res
) {

    const url =
        new URL(
            req.url,
            `http://${req.headers.host}`
        );

    const id =
        url.searchParams.get("id");


    if (!id) {

        return json(
            res,
            400,
            {
                ok: false,
                error:
                    "ID do pedido não informado."
            }
        );
    }


    const order =
        findOrder(id);


    if (!order) {

        return json(
            res,
            404,
            {
                ok: false,
                error:
                    "Pedido não encontrado."
            }
        );
    }


    /*
     * Nunca enviamos dados
     * desnecessários do cliente.
     */

    return json(
        res,
        200,
        {
            ok: true,

            order: {

                id:
                    order.id,

                product:
                    order.product.name,

                price:
                    order.product.price,

                status:
                    order.status,

                downloadUnlocked:
                    order.downloadUnlocked,

                createdAt:
                    order.createdAt
            }
        }
    );
}


/* ================================
   WEBHOOK
================================ */

async function handleWebhook(
    req,
    res
) {

    try {

        const body =
            await readBody(req);


        console.log("");
        console.log(
            "========== WEBHOOK =========="
        );

        console.log(
            JSON.stringify(
                body,
                null,
                2
            )
        );


        /*
         * Neste estágio o webhook apenas
         * recebe e registra a notificação.
         *
         * NÃO liberamos downloads aqui.
         *
         * A próxima etapa será consultar
         * o pagamento diretamente no Mercado
         * Pago antes de alterar o pedido.
         */

        return json(
            res,
            200,
            {
                ok: true,
                received: true
            }
        );


    } catch (error) {

        console.error(
            "Webhook:",
            error
        );

        return json(
            res,
            500,
            {
                ok: false
            }
        );
    }
}


/* ================================
   CONSULTAR PAGAMENTO
================================ */

async function getMercadoPagoPayment(paymentId) {

    if (!ACCESS_TOKEN) {
        return {
            configured: false,
            message: "Mercado Pago ainda não configurado."
        };
    }

    if (!/^\d+$/.test(String(paymentId))) {
        throw new Error("ID de pagamento inválido.");
    }

    const response = await fetch(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${ACCESS_TOKEN}`,
                "Accept": "application/json"
            }
        }
    );

    const data = await response.json();

    if (!response.ok) {
        console.error(
            "Mercado Pago:",
            response.status,
            data
        );

        throw new Error(
            "Não foi possível consultar o pagamento."
        );
    }

    return {
        configured: true,
        payment: {
            id: data.id,
            status: data.status,
            statusDetail: data.status_detail,
            approvedAt: data.date_approved || null,
            externalReference:
                data.external_reference || null
        }
    };
}


/* ================================
   API DE STATUS
================================ */

async function handlePaymentStatus(req, res) {

    try {

        const url = new URL(
            req.url,
            `http://${req.headers.host}`
        );

        const paymentId =
            url.searchParams.get("payment_id");

        if (!paymentId) {

            return json(
                res,
                400,
                {
                    ok: false,
                    error:
                        "payment_id não informado."
                }
            );
        }

        const result =
            await getMercadoPagoPayment(
                paymentId
            );

        return json(
            res,
            200,
            {
                ok: true,
                ...result
            }
        );

    } catch (error) {

        console.error(
            "Payment status:",
            error
        );

        return json(
            res,
            502,
            {
                ok: false,
                error:
                    error.message ||
                    "Erro ao consultar pagamento."
            }
        );
    }
}



/* ================================
   ARQUIVOS DO SITE
================================ */

function serveStatic(
    req,
    res
) {

    let pathname;

    try {

        pathname =
            decodeURIComponent(
                new URL(
                    req.url,
                    `http://${req.headers.host}`
                ).pathname
            );

    } catch {

        return json(
            res,
            400,
            {
                ok: false,
                error:
                    "URL inválida."
            }
        );
    }


    if (pathname === "/") {
        pathname =
            "/index.html";
    }


    let filePath =
        path.resolve(
            ROOT,
            "." + pathname
        );


    if (!filePath.startsWith(ROOT)) {

        return json(
            res,
            403,
            {
                ok: false,
                error:
                    "Acesso negado."
            }
        );
    }


    fs.stat(
        filePath,
        (error, stats) => {

            if (
                !error &&
                stats.isDirectory()
            ) {

                filePath =
                    path.join(
                        filePath,
                        "index.html"
                    );
            }


            fs.readFile(
                filePath,
                (err, data) => {

                    if (err) {

                        return json(
                            res,
                            404,
                            {
                                ok: false,
                                error:
                                    "Arquivo não encontrado."
                            }
                        );
                    }


                    const ext =
                        path.extname(
                            filePath
                        ).toLowerCase();


                    const types = {

                        ".html":
                            "text/html; charset=utf-8",

                        ".css":
                            "text/css; charset=utf-8",

                        ".js":
                            "application/javascript; charset=utf-8",

                        ".json":
                            "application/json; charset=utf-8",

                        ".svg":
                            "image/svg+xml",

                        ".png":
                            "image/png",

                        ".jpg":
                            "image/jpeg",

                        ".jpeg":
                            "image/jpeg",

                        ".webp":
                            "image/webp",

                        ".zip":
                            "application/zip",

                        ".txt":
                            "text/plain; charset=utf-8"
                    };


                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                types[ext] ||
                                "application/octet-stream"
                        }
                    );


                    res.end(data);
                }
            );
        }
    );
}


/* ================================
   SERVIDOR
================================ */

ensureDatabase();


const server =
    http.createServer(
        async (req, res) => {


            if (
                req.method === "GET" &&
                req.url.split("?")[0] ===
                    "/api/health"
            ) {

                return json(
                    res,
                    200,
                    {

                        ok: true,

                        service:
                            "NEXORA Payment Server",

                        payment:
                            ACCESS_TOKEN
                                ? "configured"
                                : "not_configured",

                        database:
                            fs.existsSync(
                                ORDERS_FILE
                            )
                                ? "ready"
                                : "error"
                    }
                );
            }


            if (
                req.method === "POST" &&
                req.url.split("?")[0] ===
                    "/api/create-checkout"
            ) {

                return handleCreateCheckout(
                    req,
                    res
                );
            }


            if (
                req.method === "GET" &&
                req.url.split("?")[0] ===
                    "/api/payment-status"
            ) {

                return handlePaymentStatus(
                    req,
                    res
                );
            }



            if (
                req.method === "GET" &&
                req.url.split("?")[0] ===
                    "/api/admin/orders"
            ) {

                const orders = readOrders();

                return json(
                    res,
                    200,
                    {
                        ok: true,
                        orders
                    }
                );
            }


        if (
                req.method === "GET" &&
                req.url.split("?")[0] ===
                    "/api/order"
            ) {

                return handleOrderStatus(
                    req,
                    res
                );
            }


            if (
                req.method === "POST" &&
                req.url.split("?")[0] ===
                    "/api/webhook/mercadopago"
            ) {

                return handleWebhook(
                    req,
                    res
                );
            }


            if (req.method === "GET") {

                return serveStatic(
                    req,
                    res
                );
            }


            return json(
                res,
                405,
                {
                    ok: false,
                    error:
                        "Método não permitido."
                }
            );
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
            "       NEXORA PAYMENT SERVER"
        );
        console.log(
            "================================="
        );
        console.log(
            `Servidor: ${STORE_URL}`
        );
        console.log(
            `Banco: ${ORDERS_FILE}`
        );
        console.log(
            `Mercado Pago: ${
                ACCESS_TOKEN
                    ? "CONFIGURADO"
                    : "NÃO CONFIGURADO"
            }`
        );
        console.log(
            "================================="
        );
        console.log("");
    }
);
