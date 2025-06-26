import { Elysia, file, NotFoundError } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { timingSafeEqual } from "node:crypto";
import { cors } from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import Cap from "@cap.js/server";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

const prefix = "/cap-api";
const ADMIN_KEY = process.env.ADMIN_KEY?.trim();
const dataDir = "./.data";
const keysStorePath = path.join(dataDir, "keys.json");

function generateAdminKeyHint() {
  return `\nWe've generated this one for you to use: \n\n${crypto
    .randomBytes(30)
    .toString("hex")}\n\nThen, restart this process.\n\n`;
}

if (!ADMIN_KEY) {
  console.error(
    `\nNo admin key has been set. Make sure to set it using the \n\`ADMIN_KEY\` environment variable.${generateAdminKeyHint()}`
  );
  process.exit(1);
}

if (ADMIN_KEY === "your_secret_key") {
  console.error(
    `\nDon't leave the admin key as default! Make sure to set it \nusing the \`ADMIN_KEY\` environment variable.${generateAdminKeyHint()}`
  );
  process.exit(1);
}

if (ADMIN_KEY.length < 20) {
  console.warn(
    `\n${"*".repeat(
      60
    )}\n\nThe admin key you're using is quite short. We recommend \nusing a longer one.${generateAdminKeyHint()}${"*".repeat(
      60
    )}\n`
  );
}

let keys = [];
const capInstances = new Map();

let [widgetSource, floatingSource, wasmSource, wasmLoaderSource] = [];
const updateCache = async () => {
  let cacheConfig = {};

  try {
    cacheConfig = JSON.parse(
      await fs.readFile(path.join(dataDir, "assets-cache.json"), "utf-8")
    );
  } catch {}

  const lastUpdate = cacheConfig["lastUpdate"] || 0;
  const currentTime = Date.now();
  const updateInterval = 1000 * 60 * 60 * 24; // 1 day

  if (!(currentTime - lastUpdate > updateInterval)) return;

  try {
    [widgetSource, floatingSource, wasmSource, wasmLoaderSource] =
      await Promise.all([
        fetch("https://fastly.jsdelivr.net/npm/@cap.js/widget@0.1.18").then((r) =>
          r.text()
        ),
        fetch(
          "https://fastly.jsdelivr.net/npm/@cap.js/widget@0.1.18/cap-floating.min.js"
        ).then((r) => r.text()),
        fetch(
          "https://fastly.jsdelivr.net/npm/@cap.js/wasm@0.0.5/browser/cap_wasm_bg.wasm"
        ).then((r) => r.arrayBuffer()),
        fetch(
          "https://fastly.jsdelivr.net/npm/@cap.js/wasm@0.0.5/browser/cap_wasm.min.js"
        ).then((r) => r.text()),
      ]);

    cacheConfig["lastUpdate"] = currentTime;
    await fs.writeFile(
      path.join(dataDir, "assets-cache.json"),
      JSON.stringify(cacheConfig)
    );

    await fs.writeFile(path.join(dataDir, "assets-widget.js"), widgetSource);
    await fs.writeFile(
      path.join(dataDir, "assets-floating.js"),
      floatingSource
    );
    await fs.writeFile(
      path.join(dataDir, "assets-cap_wasm_bg.wasm"),
      Buffer.from(wasmSource)
    );
    await fs.writeFile(
      path.join(dataDir, "assets-cap_wasm.js"),
      wasmLoaderSource
    );

    console.log("[asset server] updated assets cache");
  } catch (e) {
    console.error(
      "[asset server] error updating assets cache, trying to load them might fail:",
      e
    );
  }
};

const init = async () => {
  try {
    await fs.mkdir(dataDir, { recursive: true });

    const data = await fs.readFile(keysStorePath, "utf-8");
    keys = JSON.parse(data);
    capInstances.clear();

    keys.forEach((key) => {
      capInstances.set(
        key.publicKey,
        new Cap({
          tokens_store_path: path.join(dataDir, `tokens-${key.publicKey}.json`),
        })
      );
    });
  } catch {
    await fs.writeFile(keysStorePath, "[]");
    keys = [];
    capInstances.clear();
  }

  await updateCache();
};

const saveKeys = async () => {
  await fs.writeFile(keysStorePath, JSON.stringify(keys));
};

const getCapInstance = (publicKey) => {
  if (!capInstances.has(publicKey) || !capInstances.get(publicKey)) {
    const keyData = keys.find((k) => k.publicKey === publicKey);
    if (keyData) {
      capInstances.set(
        publicKey,
        new Cap({
          tokens_store_path: path.join(dataDir, `tokens-${publicKey}.json`),
        })
      );
    }
  }
  return capInstances.get(publicKey);
};

const auth = new Elysia({
  prefix: "/internal/auth",
})
  // .use(
  //   rateLimit({
  //     scoping: "scoped",
  //     count: 10,
  //     duration: 15000,
  //   })
  // )
  .post("/", async ({ body, cookie, set }) => {
    if (
      !body?.password || body.password.length!==ADMIN_KEY.length ||
      !timingSafeEqual(Buffer.from(body.password), Buffer.from(ADMIN_KEY))
    ) {
      set.status = 401;
      return { success: false };
    }

    cookie["cap-admin-key"].set({
      value: await Bun.password.hash(body.password),
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 86400 * 7,
    });

    return { success: true };
  })
  .get("/logout", ({ cookie, redirect }) => {
    cookie["cap-admin-key"].remove();
    return redirect(prefix+"/");
  });

const internal = new Elysia({ prefix: "/internal" })
  .onBeforeHandle(async ({ cookie, set }) => {
    const authCookie = cookie["cap-admin-key"]?.value;
    if (!authCookie || !(await Bun.password.verify(ADMIN_KEY, authCookie))) {
      set.status = 401;
      return {
        success: false,
        message: "Unauthorized",
      };
    }
  })
  // .use(
  //   rateLimit({
  //     scoping: "scoped",
  //     number: 60,
  //     duration: 10000,
  //   })
  // )
  .post(
    "/createKey",
    async ({
      body: {
        keyName,
        challengesCount = 18,
        challengeSize = 32,
        challengeDifficulty = 4,
        expiresMs = 600000,
      },
      set,
    }) => {
      if (!keyName?.trim()) {
        set.status = 400;
        return { success: false, message: "Key name is required" };
      }

      const publicKey = crypto.randomBytes(6).toString("hex");
      const privateKey = crypto.randomBytes(25).toString("hex");
      const privateKeyHash = await Bun.password.hash(privateKey);

      const newKey = {
        name: keyName,
        publicKey,
        privateKey: privateKeyHash,
        challengesCount: Number(challengesCount),
        challengeSize: Number(challengeSize),
        challengeDifficulty: Number(challengeDifficulty),
        expiresMs: Number(expiresMs),
      };

      keys.push(newKey);
      await saveKeys();

      getCapInstance(publicKey);

      set.status = 201;
      return {
        success: true,
        publicKey,
        privateKey,
      };
    }
  )
  .post(
    "/editKey",
    async ({
      body: {
        publicKey,
        keyName,
        challengesCount,
        challengeSize,
        challengeDifficulty,
        expiresMs,
      },
      set,
    }) => {
      const keyIndex = keys.findIndex((key) => key.publicKey === publicKey);

      if (keyIndex === -1) {
        set.status = 404;
        return { success: false, message: "Key not found" };
      }

      if (!keyName.trim()) {
        set.status = 400;
        return { success: false, message: "Key name is required" };
      }

      const existingKey = keys[keyIndex];
      keys[keyIndex] = {
        ...existingKey,
        name: keyName,
        challengesCount: Number(challengesCount),
        challengeSize: Number(challengeSize),
        challengeDifficulty: Number(challengeDifficulty),
        expiresMs: Number(expiresMs),
      };

      await saveKeys();

      return { success: true };
    }
  )
  .get("/listKeys", async () => {
    return {
      keys: keys.map(({ privateKey, ...rest }) => rest),
    };
  })
  .post("/deleteKey", async ({ body: { publicKey }, set }) => {
    const initialLength = keys.length;
    keys = keys.filter((key) => key.publicKey !== publicKey);

    if (keys.length === initialLength) {
      set.status = 404;
      return { success: false, message: "Key not found" };
    }

    await saveKeys();

    const tokenFilePath = path.join(dataDir, `tokens-${publicKey}.json`);
    try {
      await fs.unlink(tokenFilePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(
          `Could not delete token file ${tokenFilePath}:`,
          error.message
        );
      }
    }

    capInstances.delete(publicKey);

    set.status = 200;
    return { success: true };
  })
  .post("/rotateKey", async ({ body: { publicKey }, set }) => {
    const keyIndex = keys.findIndex((key) => key.publicKey === publicKey);

    if (keyIndex === -1) {
      set.status = 404;
      return { success: false, message: "Key not found" };
    }

    const newPrivateKey = crypto.randomBytes(25).toString("hex");
    const newPrivateKeyHash = await Bun.password.hash(newPrivateKey);

    keys[keyIndex].privateKey = newPrivateKeyHash;

    await saveKeys();

    return { success: true, privateKey: newPrivateKey };
  });

const api = new Elysia({ prefix: "/:key" })
  .use(
    cors({
      origin: process.env.CORS_ORIGIN || true,
    })
  )
  // .use(
  //   rateLimit({
  //     scoping: "scoped",
  //     number: 80,
  //     duration: 1000,
  //   })
  // )
  .derive(({ params }) => {
    const keyData = keys.find((k) => k.publicKey === params.key);
    if (!keyData) {
      throw new NotFoundError("Key not found");
    }
    return { keyData, capInstance: getCapInstance(params.key) };
  })
  .post("/api/challenge", async ({ keyData, capInstance }) => {
    return await capInstance.createChallenge({
      challengeSize: keyData.challengeSize,
      challengeDifficulty: keyData.challengeDifficulty,
      challengeCount: keyData.challengesCount,
      expiresMs: keyData.expiresMs,
    });
  })
  .post("/api/redeem", async ({ body, set, capInstance }) => {
    const { token, solutions } = body;

    if (!token || !solutions) {
      set.status = 400;
      return { success: false, message: "Missing solutions and/or token" };
    }

    return await capInstance.redeemChallenge({ token, solutions });
  })
  .post("/siteverify", async ({ body, set, keyData, capInstance }) => {
    const { secret, response } = body;

    if (!secret || !response) {
      set.status = 400;
      return { success: false, message: "Missing secret or/and response" };
    }

    if (!(await Bun.password.verify(secret, keyData.privateKey))) {
      set.status = 400;
      return { success: false, message: "Invalid secret" };
    }

    return await capInstance.validateToken(response, {
      keepToken: false,
    });
  });

const assetsServer = new Elysia({ prefix: "/assets" })
  .use(
    cors({
      origin: process.env.CORS_ORIGIN || true
    })
  )
  .get("/widget.js", ({ set }) => {
    set.headers["Content-Type"] = "text/javascript";
    set.headers["Cache-Control"] = "max-age=31536000";
    return widgetSource ? widgetSource : file(path.join(dataDir, "assets-widget.js"));
  })
  .get("/floating.js", ({ set }) => {
    set.headers["Content-Type"] = "text/javascript";
    set.headers["Cache-Control"] = "max-age=31536000";
    return floatingSource ? floatingSource : file(path.join(dataDir, "assets-floating.js"));
  })
  .get("/cap_wasm_bg.wasm", ({ set }) => {
    set.headers["Content-Type"] = "application/wasm";
    set.headers["Cache-Control"] = "max-age=31536000";
    return wasmSource ? wasmSource : file(path.join(dataDir, "assets-cap_wasm_bg.wasm"));
  })
  .get("/cap_wasm.js", ({ set }) => {
    set.headers["Content-Type"] = "text/javascript";
    set.headers["Cache-Control"] = "max-age=31536000";
    return wasmLoaderSource ? wasmLoaderSource : file(path.join(dataDir, "assets-cap_wasm.js"));
  });

new Elysia()
  .use(staticPlugin())
  .use(auth)
  .use(internal)
  .use(api)
  .use(assetsServer)
  .get("/", async ({ cookie }) => {
    const authCookie = cookie["cap-admin-key"]?.value;
    const isAuthed =
      authCookie && (await Bun.password.verify(ADMIN_KEY, authCookie));

    return file(isAuthed ? "./public/index.html" : "./public/lock.html");
  })
  .listen(3000);

console.log(`Cap standalone running on http://localhost:3000`);
init();
