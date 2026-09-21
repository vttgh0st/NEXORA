// =========================
// CADASTRO DE USUÁRIO
// =========================

if (
    req.method === "POST" &&
    url.pathname === "/api/register"
) {

    const body = await readBody(req);

    const nome = String(body.nome || "").trim();
    const email = String(body.email || "").trim();
    const senha = String(body.senha || "").trim();

    if (!nome || !email || !senha) {

        return sendJSON(
            res,
            400,
            {
                ok:false,
                error:"Preencha todos os campos."
            }
        );
    }


    const USERS_FILE =
        path.join(
            DATA_DIR,
            "users.json"
        );


    let users = [];

    if(fs.existsSync(USERS_FILE)){

        users =
        JSON.parse(
            fs.readFileSync(
                USERS_FILE,
                "utf8"
            )
        );

    }


    const exists =
        users.find(
            u => u.email === email
        );


    if(exists){

        return sendJSON(
            res,
            400,
            {
                ok:false,
                error:"Usuário já existe."
            }
        );

    }


    users.push({

        id: crypto.randomUUID(),

        nome,

        email,

        senha,

        criado:
        new Date().toISOString()

    });


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

