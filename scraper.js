const puppeteer = require("puppeteer");
require("dotenv").config();
const { authenticator } = require("otplib");
const express = require("express");

// Configuración básica de Express para manejar el webhook
const app = express();
const port = 3000;

app.use(express.json());

// Obtén el secreto TOTP desde las variables de entorno
const secret = process.env.TOTP_SECRET || "F6AH7JVXZEQW5S4L";
if (!secret) {
  console.error(
    "TOTP_SECRET no está configurado. Por favor, configúralo en las variables de entorno."
  );
  process.exit(1);
}

/**
 * Genera el token TOTP basado en el secreto configurado.
 * @returns {string|null} El token generado o null en caso de error.
 */
function generateToken() {
  try {
    return authenticator.generate(secret);
  } catch (error) {
    console.error("Error al generar el token TOTP:", error);
    return null;
  }
}

/**
 * Función principal que muestra el token inicial.
 */
function main() {
  const token = generateToken();
  if (token) {
    console.log(`${new Date().toISOString()}] Token 2FA actual: ${token}`);
  }
  return token;
}

/**
 * Función para hacer login, buscar el orderId, seleccionar el checkbox de la fila
 * que coincide, desplegar las acciones, seleccionar la opción de generar etiqueta,
 * hacer clic en el botón de acción y extraer el código de seguimiento.
 *
 * Además, intercepta la petición de búsqueda para capturar el token de autorización.
 *
 * @param {string} email - El correo electrónico para el login.
 * @param {string} password - La contraseña para el login.
 * @param {string} orderId - El ID de la orden a buscar en la tabla.
 */
async function loginTiendanube(email, password, orderId, res) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1080 });

    // ----- INTERCEPTAR LA PETICIÓN PARA CAPTURAR EL TOKEN DE AUTORIZACIÓN -----
    let authorizationToken = "";
    page.on("request", (request) => {
      const requestUrl = request.url();
      if (
        requestUrl.includes(
          "nuvem-envio-app-back.ms.tiendanube.com/stores/orders"
        )
      ) {
        const headers = request.headers();
        if (headers.authorization) {
          authorizationToken = headers.authorization;
          console.log("Authorization token captured:", authorizationToken);
        }
      }
    });
    // --------------------------------------------------------------------------

    await page.goto("https://www.tiendanube.com/login", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    await page.waitForSelector("#user-mail", { visible: true, timeout: 10000 });
    await page.waitForSelector("#pass", { visible: true, timeout: 10000 });

    await page.type("#user-mail", email, { delay: 100 });
    await page.type("#pass", password, { delay: 100 });

    await Promise.all([
      page.click(".js-tkit-loading-button"),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
    ]);

    const token = main();
    if (!token) throw new Error("No se pudo generar el token 2FA.");
    await page.type("#code", token, { delay: 100 });

    try {
      await Promise.all([
        page.click("#authentication-factor-verify-page input[type='submit']"),
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
      ]);
    } catch (error) {
      console.warn(
        "Advertencia: La navegación después del 2FA pudo haber fallado o tardado demasiado.",
        error
      );
      return res
        .status(500)
        .send(
          "Advertencia: La navegación después del 2FA pudo haber fallado o tardado demasiado."
        );
    }

    try {
      await page.goto(
        "https://perlastore6.mitiendanube.com/admin/v2/apps/envionube/ar/dashboard",
        {
          waitUntil: "networkidle2",
          timeout: 60000,
        }
      );
    } catch (error) {
      console.warn(
        "Advertencia: Timeout al navegar al dashboard. Se continuará para extraer la tabla...",
        error
      );
      return res
        .status(500)
        .send(
          "Advertencia: Timeout al navegar al dashboard. Se continuará para extraer la tabla..."
        );
    }

    const iframeHandle = await page.waitForSelector(
      'iframe[data-testid="iframe-app"]',
      { visible: true, timeout: 60000 }
    );
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error("No se pudo obtener el contenido del iframe.");

    const searchInput = await frame.waitForSelector(
      ".nimbus-input_input__rlcyv70",
      {
        visible: true,
        timeout: 30000,
      }
    );
    await searchInput.click();
    await searchInput.type(orderId, { delay: 100 });
    await searchInput.press("Enter");

    let rowFound = false;
    try {
      await frame.waitForFunction(
        (orderId) => {
          const tables = Array.from(document.querySelectorAll("table"));
          return tables.some((table) => table.innerText.includes(orderId));
        },
        { timeout: 60000 },
        orderId
      );
    } catch (error) {
      console.error(
        `Error durante el proceso: No se encontró la orden ${orderId}`
      );
      return res.status(500).send(`Error: No se encontró la orden ${orderId}`);
    }

    console.log(
      "Contenido de la tabla después de la búsqueda (formato estructurado):"
    );
    const tableData = await frame.$$eval("table", (tables) => {
      const table = tables[0];
      if (!table) return [];
      const rows = Array.from(table.querySelectorAll("tr"));
      return rows.map((row) => {
        const cells = Array.from(row.querySelectorAll("th, td"));
        return cells.map((cell) => cell.innerText.trim());
      });
    });
    tableData.forEach((row, index) => {
      console.log(`Fila ${index + 1}: ${row.join(" | ")}`);
    });

    const rowHandles = await frame.$$("table tbody tr");
    for (const rowHandle of rowHandles) {
      const rowText = await rowHandle.evaluate((row) => row.innerText);
      if (rowText.includes(orderId)) {
        rowFound = true;

        const checkbox = await rowHandle.$("td:nth-child(1) > label");
        if (!checkbox) {
          console.error(
            `No se encontró el checkbox en la fila que contiene la orden ${orderId}`
          );
          break;
        }
        await checkbox.click();

        const dropdownSelector =
          "#root > main > section > div > div.nimbus-box_display-none-xs__cklfiipr.nimbus-box_display-block-md__cklfiioj.nimbus-box_width-xs__cklfii9.nimbus-box_boxSizing-border-box-xs__cklfii100 > div > div.nimbus-box_position-relative-xs__cklfii129.nimbus-box_borderRadius-xs__cklfiie9.nimbus-box_borderColor-xs__cklfiidr.nimbus-box_borderStyle-solid-xs__cklfiiyr.nimbus-box_borderWidth-xs__cklfiier.nimbus-box_boxSizing-border-box-xs__cklfii100 > div > div";
        await frame.waitForSelector(dropdownSelector, {
          visible: true,
          timeout: 10000,
        });
        await frame.click(dropdownSelector);

        const optionValue = await frame.$eval(
          "#massive-actions > option:nth-child(2)",
          (el) => el.value
        );
        await frame.select("#massive-actions", optionValue);

        const actionButtonSelector =
          "button.nimbus-button_appearance_primary__fymkre1:nth-child(2)";
        await frame.waitForSelector(actionButtonSelector, {
          visible: true,
          timeout: 10000,
        });
        await frame.click(actionButtonSelector);

        const trackingSelector =
          "tbody.nimbus-table_container__body__1ifaixp2:nth-child(2) > tr:nth-child(1) > td:nth-child(6) > a:nth-child(1)";
        await frame.waitForSelector(trackingSelector, {
          visible: true,
          timeout: 30000,
        });

        const fullTrackingCode = await frame.$eval(trackingSelector, (el) => {
          return el.getAttribute("title") || el.textContent.trim();
        });
        await frame.click(trackingSelector);
        console.log("Código de seguimiento completo:", fullTrackingCode);
        break;
      }
    }
    if (!rowFound) {
      console.warn(
        `No se encontró ninguna fila que coincida con la orden ${orderId}`
      );
      return res.status(500).send(`Error: No se encontró la orden ${orderId}`);
    }

    console.log("Token de autorización final:", authorizationToken);
    return res.status(200).send("Proceso completado con éxito");
  } catch (error) {
    console.error("Error durante el proceso:", error);
    return res.status(500).send(`Error durante el proceso: ${error.message}`);
  } finally {
    if (browser) {
      console.log("Cerrando navegador...");
      await browser.close();
    }
  }
}

// Configurar el webhook en Express para recibir el orderId desde n8n
app.post("/webhook", (req, res) => {
  const orderId = req.body.orderId; // Se asume que el body contiene el orderId
  console.log(`Recibido orderId desde el webhook: ${orderId}`);

  // Llamar a la función de Puppeteer con el orderId recibido
  loginTiendanube(
    "automatizaciones@perlastorearg.com",
    "Tomiltm123456",
    orderId,
    res
  );
});

app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
