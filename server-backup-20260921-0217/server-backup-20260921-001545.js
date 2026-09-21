const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");


/*
============================================================
NEXORA PAYMENT SERVER
============================================================

IMPORTANTE:

- O Access Token fica SOMENTE no servidor.
- Nunca coloque credenciais no HTML.
- O pagamento real será feito pelo provedor.
- A confirmação definitiva deverá vir do webhook.
*/


const PORT =
    Number(process.env.PORT || 3000);


const ACCESS_TOKEN =
    process.env.MERCADOPAGO_ACCESS_TOKEN || "";


const STORE_URL =
    process.env.STORE_URL ||
    "http://localhost:3000";


const PRODUCT = {
    id: "creator-pack",
    title: "NEXORA Creator Pack",
    price: 19.90,
    currency: "BRL"
};


function sendJSON(res, status, data){

    const body =
        JSON.stringify(data, null, 2);

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });

    res.end(body);
}


function sendText(res, status, text){

    res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end(text);
}


function readBody(req){

    return new Promise((resolve, reject) => {

        let data = "";

        req.on("data", chunk => {

            data += chunk;

            if(data.length > 1000000){

                req.destroy();

                reject(
                    new Error("Payload muito grande")
                );
            }

        });

        req.on("end", () => {

            try{

                resolve(
                    data ? JSON.parse(data) : {}
                );

            }catch(error){

                reject(
                    new Error("JSON inválido")
                );
            }

        });

        req.on("error", reject);

    });

}


function generateOrderId(){

    const random =
        crypto.randomBytes(5).toString("hex").toUpperCase();

    return `NEX-${Date.now()}-${random}`;
}


function isValidEmail(email){

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


async function createMercadoPagoPreference(order){

    if(!ACCESS_TOKEN){

        throw new Error(
            "MERCADOPAGO_ACCESS_TOKEN não configurado"
        );

    }


    const preference = {

        items: [
            {
                id: PRODUCT.id,
                title: PRODUCT.title,
                quantity: 1,
                unit_price: PRODUCT.price,
                currency_id: PRODUCT.currency
            }
        ],

        external_reference:
            order.id,

        back_urls: {

            success:
                `${STORE_URL}/payment-success/`,

            failure:
                `${STORE_URL}/payment-failure/`,

            pending:
                `${STORE_URL}/payment-pending/`

        }

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
                JSON.stringify(preference)

        }
    );


    const data =
        await response.json();


    if(!response.ok){

        throw new Error(
            data.message ||
            "Erro ao criar preferência"
        );

    }


    return data;

}


async function handleCreateCheckout(req, res){

    try{

        const body =
            await readBody(req);


        const name =
            String(body.name || "").trim();


        const email =
            String(body.email || "").trim();


        if(name.length < 2){

            return sendJSON(
                res,
                400,
                {
                    ok:false,
                    error:"Nome inválido."
                }
            );

        }


        if(!isValidEmail(email)){

            return sendJSON(
                res,
                400,
                {
                    ok:false,
                    error:"E-mail inválido."
                }
            );

        }


        const order = {

            id:
                generateOrderId(),

            product:
                PRODUCT.id,

            productName:
                PRODUCT.title,

            amount:
                PRODUCT.price,

            currency:
                PRODUCT.currency,

            customer: {

                name,
                email

            },

            status:
                "pending_payment",

            createdAt:
                new Date().toISOString()

        };


        /*
        ----------------------------------------------------
        MODO PREPARAÇÃO
        ----------------------------------------------------

        Sem token, não chamamos o Mercado Pago.
        Isso permite testar o backend sem expor credenciais.
        */

        if(!ACCESS_TOKEN){

            return sendJSON(
                res,
                200,
                {
                    ok:true,

                    mode:"setup",

                    message:
                        "Backend funcionando. Configure MERCADOPAGO_ACCESS_TOKEN para criar o checkout real.",

                    order
                }
            );

        }


        const preference =
            await createMercadoPagoPreference(order);


        return sendJSON(
            res,
            200,
            {
                ok:true,

                mode:"mercadopago",

                orderId:
                    order.id,

                checkoutUrl:
                    preference.init_point,

                preferenceId:
                    preference.id
            }
        );


    }catch(error){

        console.error(error);


        return sendJSON(
            res,
            500,
            {
                ok:false,

                error:
                    error.message ||
                    "Erro interno do servidor."
            }
        );

    }

}


function handleWebhook(req, res){

    /*
    --------------------------------------------------------
    WEBHOOK

    O provedor enviará notificações para este endpoint.

    A validação de assinatura deverá ser ativada quando
    a URL pública HTTPS e a chave secreta do webhook
    estiverem configuradas.
    --------------------------------------------------------
    */

    console.log(
        "[NEXORA WEBHOOK]",
        new Date().toISOString()
    );


    sendJSON(
        res,
        200,
        {
            ok:true,
            received:true
        }
    );

}


function serveStatic(req, res){

    let url =
        decodeURIComponent(
            req.url.split("?")[0]
        );


    if(url === "/"){
        url = "/index.html";
    }


    const publicRoot =
        path.resolve(__dirname, "..");


    const requested =
        path.resolve(
            publicRoot,
            "." + url
        );


    if(
        !requested.startsWith(
            publicRoot + path.sep
        ) &&
        requested !== publicRoot
    ){

        return sendText(
            res,
            403,
            "Forbidden"
        );

    }


    fs.stat(
        requested,
        (error, stat) => {

            if(error){

                return sendText(
                    res,
                    404,
                    "Not Found"
                );

            }


            if(stat.isDirectory()){

                const index =
                    path.join(
                        requested,
                        "index.html"
                    );


                return fs.stat(
                    index,
                    (indexError) => {

                        if(indexError){

                            return sendText(
                                res,
                                404,
                                "Not Found"
                            );

                        }


                        sendFile(
                            res,
                            index
                        );

                    }
                );

            }


            sendFile(
                res,
                requested
            );

        }
    );

}


function sendFile(res, file){

    const ext =
        path.extname(file).toLowerCase();


    const types = {

        ".html":
            "text/html; charset=utf-8",

        ".css":
            "text/css; charset=utf-8",

        ".js":
            "text/javascript; charset=utf-8",

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


    fs.createReadStream(file)
        .pipe(res);

}


const server =
    http.createServer(
        async (req, res) => {

            const url =
                req.url.split("?")[0];


            if(
                req.method === "GET" &&
                url === "/api/health"
            ){

                return sendJSON(
                    res,
                    200,
                    {
                        ok:true,

                        service:
                            "NEXORA Payment Server",

                        payment:
                            ACCESS_TOKEN
                                ? "configured"
                                : "not_configured",

                        timestamp:
                            new Date().toISOString()
                    }
                );

            }


            if(
                req.method === "POST" &&
                url === "/api/create-checkout"
            ){

                return handleCreateCheckout(
                    req,
                    res
                );

            }


            if(
                req.method === "POST" &&
                url === "/api/webhook/mercadopago"
            ){

                return handleWebhook(
                    req,
                    res
                );

            }


            if(req.method === "GET"){

                return serveStatic(
                    req,
                    res
                );

            }


            sendText(
                res,
                405,
                "Method Not Allowed"
            );

        }
    );


server.listen(
    PORT,
    () => {

        console.log("");
        console.log("======================================");
        console.log(" NEXORA PAYMENT SERVER");
        console.log("======================================");
        console.log("");
        console.log(
            `Local: http://localhost:${PORT}`
        );
        console.log(
            `Health: http://localhost:${PORT}/api/health`
        );
        console.log("");
        console.log(
            "Mercado Pago:",
            ACCESS_TOKEN
                ? "CONFIGURADO"
                : "AINDA NÃO CONFIGURADO"
        );
        console.log("");
        console.log("Servidor pronto.");
        console.log("");

    }
);
