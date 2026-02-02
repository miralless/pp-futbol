const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const admin = require('firebase-admin');
const path = require('path');

// 1. CONFIGURACIÓN DE FIREBASE
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : require("./serviceAccountKey.json");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();
puppeteer.use(StealthPlugin());

// --- FUNCIONES AUXILIARES ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const crearIdDoc = (tipo, nombre) => {
    return `${tipo}_${nombre.toLowerCase().replace(/\s+/g, '_').replace(/[^\w]/g, '')}`;
};

/**
 * Pasa fechas de "1/2/26" a "01/02/2026"
 */
function formatearFecha(fechaSucio) {
    if (!fechaSucio) return "";
    const limpia = fechaSucio.replace(/-/g, '/');
    const partes = limpia.split('/');
    if (partes.length !== 3) return fechaSucio;

    const dia = partes[0].padStart(2, '0');
    const mes = partes[1].padStart(2, '0');
    let anio = partes[2];
    if (anio.length === 2) anio = "20" + anio;
    
    return `${dia}/${mes}/${anio}`;
}

async function scriptIntegradoFutbol() {
    console.log("🚀 Iniciando extracción...");
    
    const baseDeDatosFutbol = [];
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=es-ES,es', '--disable-web-security',] 
    });

    let jEibarB = 0, jDerio = 0, jCartagena = 0, jIndartsu = 0;

    try {
        const equiposLaPreferente = [
            { nombre: "Eibar B", url: "https://www.sofascore.com/es/football/team/sd-eibar-b/750559", fotmob: "https://www.fotmob.com/teams/189634/overview/eibar-b" },
            { nombre: "CD Derio", url: "https://www.sofascore.com/es/football/team/cd-derio/488513" },
            { nombre: "FC Cartagena", url: "https://www.sofascore.com/es/football/team/fc-cartagena/24329", fotmob: "https://www.fotmob.com/teams/8554/overview/cartagena" }
        ];

        for (const e of equiposLaPreferente) {
            const page = await browser.newPage();
            
            // Configuración de pantalla solicitada
            await page.setViewport({ width: 800, height: 731 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            try {
                await page.goto(e.url, { waitUntil: 'networkidle2', timeout: 60000 });

                // Aceptar cookies rápido
                try {
                    const btnCookies = await page.waitForSelector('button[id*="onetrust-accept"]', { timeout: 3000 });
                    await btnCookies.click();
                } catch (err) {}

                // --- 1. Ir a la pestaña de Partidos ---
const selectorTabPartidos = 'button[data-testid="tab-matches"]';
await page.waitForSelector(selectorTabPartidos, { visible: true, timeout: 20000 });

// Click mediante evaluate para saltar bloqueos visuales
await page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (btn) btn.click();
}, selectorTabPartidos);

await delay(2000); // Espera breve para que cargue el submenú

// --- 2. Ir a la pestaña de Resultados ---
// Buscamos cualquier elemento que diga "Resultados" dentro de la zona de pestañas
try {
    await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('button, a, div[role="tab"]'));
        const btnResultados = tabs.find(t => /Resultados/i.test(t.innerText));
        if (btnResultados) {
            btnResultados.scrollIntoView();
            btnResultados.click();
        }
    });
    
    // Esperamos específicamente a que el contenedor de resultados cambie
    // En lugar de un delay fijo, esperamos a que aparezca un partido finalizado
    await page.waitForFunction(() => 
        Array.from(document.querySelectorAll('a[data-id]')).some(a => a.innerText.includes('Final')),
        { timeout: 15000 }
    ).catch(() => console.log("      (Nota: No se detectaron partidos con texto 'Final' tras el click)"));

} catch (err) {
    console.log("   ⚠️ Fallo al intentar pulsar en 'Resultados'");
}

// --- 3. Extracción final ---
const ultimoResultado = await page.evaluate((nFiltro) => {
    // 1. Localizar el contenedor de la lista
    const contenedor = document.querySelector('div.pb_sm.pt_xs');
    if (!contenedor) return null;

    // 2. Localizar los bloques de partido (enlaces con data-id)
    const partidos = Array.from(contenedor.querySelectorAll('a[data-id]'));
    
    // 3. Seleccionar el segundo partido (índice 1) si existe, sino el primero
    const elPartido = partidos[0];
    if (!elPartido) return null;

    // 4. EXTRAER EQUIPOS: Buscamos los bdi que están dentro de la sección de nombres
    // Filtramos por aquellos que tienen la clase de truncado típica de SofaScore para nombres
    const bdisEquipos = Array.from(elPartido.querySelectorAll('bdi.trunc_true'));
    
    // 5. EXTRAER MARCADOR: Buscamos los span con la clase score
    const scores = Array.from(elPartido.querySelectorAll('span.score'))
                        .map(s => s.innerText.trim())
                        .filter(t => t !== "" && !t.includes(':')); // Evitamos horas

    // 6. EXTRAER FECHA
    const fechaElemento = elPartido.querySelector('bdi');
    const fechaPartida = fechaElemento ? fechaElemento.innerText.trim() : "---";                    

    if (bdisEquipos.length >= 2 && scores.length >= 2) {
        return {
            local: bdisEquipos[1].innerText,
            visitante: bdisEquipos[2].innerText,
            fecha: fechaPartida,
            resultado: `${scores[1]} - ${scores[2]}`,
            jornada: `JORNADA ${partidos.length}`
        };
    }
    
    return null;
}, e.nombre);

                // Guardamos solo el último, ya que el próximo ya lo tienes en otra parte
                baseDeDatosFutbol.push({
                    nombre: e.nombre,
                    tipo: "equipo",
                    origen: "SofaScore",
                    ultimo: ultimoResultado
                });

                console.log(`✅ Último partido de ${e.nombre} guardado.`);

            } catch (err) {
                console.error(`❌ Error procesando ${e.nombre}:`, err.message);
            } finally {
                await page.close();
            }
        }

        // --- 2. EQUIPO INDARTSU (FEDERACIÓN) ---
        const pageInd = await browser.newPage();
        try {
            await pageInd.goto("https://www.fvf-bff.eus/pnfg/NPcd/NFG_VisCompeticiones_Grupo?cod_primaria=1000123&codequipo=30094&codgrupo=22682897", { waitUntil: 'networkidle2' });
            
            const dataInd = await pageInd.evaluate(() => {
                const filas = Array.from(document.querySelectorAll('tbody tr'));
                const listaCompleta = [];
                let maxJornada = 0;

                filas.forEach(f => {
                    const tds = f.querySelectorAll('td');
                    if (tds.length < 3) return;

                    const jNum = parseInt(tds[0].innerText.trim());
                    const h5s = Array.from(tds[1].querySelectorAll('h5'));
                    
                    const eq1 = h5s[0]?.innerText.trim() || "---";
                    const eq2 = h5s[1]?.innerText.trim() || "---";
                    const fechaHoraTexto = h5s[2]?.innerText.replace(/\s+/g, ' ').trim() || ""; 
                    const partes = fechaHoraTexto.split(' '); 
                    
                    const res = tds[2].innerText.trim();
                    const yaJugado = /\d/.test(res);

                    if (yaJugado && jNum > maxJornada) maxJornada = jNum;

                    listaCompleta.push({
                        jNum: jNum,
                        fecha: partes[0] || "---",
                        hora: partes[1] || "---",
                        equipo_1: eq1,
                        equipo_2: eq2,
                        resultado: res,
                        yaJugado: yaJugado
                    });
                });

                const jugados = listaCompleta.filter(p => p.yaJugado);
                const futuros = listaCompleta.filter(p => !p.yaJugado);
                const u = jugados[jugados.length - 1];
                const p = futuros[0];

                return { 
                    ultimo: u ? { infoJornada: `JORNADA ${u.jNum}`, fRaw: u.fecha, rival: u.equipo_1.toUpperCase().includes("INDARTSU") ? `${u.equipo_2} (C)` : `${u.equipo_1} (F)`, resultado: u.resultado } : null, 
                    proximo: p ? { infoJornada: `JORNADA ${p.jNum}`, rival: p.equipo_1.toUpperCase().includes("INDARTSU") ? `${p.equipo_2} (C)` : `${p.equipo_1} (F)`, fRaw: p.fecha, hRaw: p.hora } : null, 
                    jornadaNum: maxJornada,
                    partidosRaw: listaCompleta 
                };
            });

            if (dataInd.ultimo && dataInd.ultimo.fRaw) {
                dataInd.ultimo.infoJornada = `JORNADA ${dataInd.jornadaNum} (${formatearFecha(dataInd.ultimo.fRaw)})`;
                delete dataInd.ultimo.fRaw;
            }
            if (dataInd.proximo) {
                dataInd.proximo.resultado = `${formatearFecha(dataInd.proximo.fRaw)} ${dataInd.proximo.hRaw}`.trim();
                delete dataInd.proximo.fRaw; delete dataInd.proximo.hRaw;
            }
            
            jIndartsu = dataInd.jornadaNum;

            // A) Registro tipo "equipo" (Resumen: último y próximo)
            const { partidosRaw, ...datosEquipo } = dataInd;
            baseDeDatosFutbol.push({ 
                nombre: "Indartsu", 
                tipo: "equipo", 
                origen: "Federacion", 
                ...datosEquipo 
            });

            // B) Registro tipo "lista_partidos" (Solo futuros: yaJugado === false)
            if (partidosRaw && partidosRaw.length > 0) {
                const partidosFuturos = partidosRaw
                    .filter(p => !p.yaJugado) // <--- FILTRO PARA QUEDARNOS SOLO CON LOS NO JUGADOS
                    .map(p => ({
                        fecha: p.fecha,
                        resultado_hora: p.hora, // Como no están jugados, guardamos la hora
                        equipo_1: p.equipo_1,
                        equipo_2: p.equipo_2
                    }));

                if (partidosFuturos.length > 0) {
                    baseDeDatosFutbol.push({
                        nombre: "indartsu",
                        tipo: "lista_partidos",
                        origen: "Federacion",
                        partidos: partidosFuturos
                    });
                }
            }

            console.log(`✅ Equipo Indartsu y lista_partidos_indartsu (solo futuros) preparados`);
        } catch (e) { 
            console.error("❌ Error Indartsu:", e.message); 
        } finally { 
            await pageInd.close(); 
        }

        // --- 2.1 CLASIFICACIÓN FC CARTAGENA ---
        const pageClasCartagena = await browser.newPage();
        try {
            // URL de LaPreferente para el Eibar B
            await pageClasCartagena.goto("https://www.lapreferente.com/E712C22270-1/fc-cartagena-sad", { waitUntil: 'networkidle2' });
            
            const tablaCartagena = await pageClasCartagena.evaluate(() => {
                // Buscamos la tabla con el ID específico
                const tabla = document.getElementById('tableClasif');
                if (!tabla) return [];

                // Obtenemos las filas del cuerpo de la tabla
                const filas = Array.from(tabla.querySelectorAll('tbody tr'));
                
                return filas.map(f => {
                    const tds = f.querySelectorAll('td');
                    
                    // Verificamos que la fila tenga al menos 10 celdas para evitar errores
                    if (tds.length < 10) return null;

                    // Mapeo según tus instrucciones: 3º (índice 2) y 5º-10º (índices 4-9)
                    // Nota: En LaPreferente las columnas suelen ser PJ, G, E, P, GF, GC...
                    return {
                        nombre: tds[2]?.innerText.trim(),         // 3º TD: Nombre Equipo
                        Jugados: tds[4]?.innerText.trim(),        // 5º TD: Partidos Jugados
                        Ganados: tds[5]?.innerText.trim(),        // 6º TD: Ganados
                        Empatados: tds[6]?.innerText.trim(),      // 7º TD: Empatados
                        Perdidos: tds[7]?.innerText.trim(),       // 8º TD: Perdidos
                        GolesFavor: tds[8]?.innerText.trim(),     // 9º TD: Goles a Favor
                        GolesContra: tds[9]?.innerText.trim()      // 10º TD: Goles en Contra
                    };
                }).filter(e => e !== null);
            });

            if (tablaCartagena.length > 0) {
                tablaCartagena.forEach(element => {
                    if (element.nombre == "F.C. Cartagena") {
                        jCartagena = element.Jugados;
                    }
                });
                // Lo guardamos en tu array de base de datos
                baseDeDatosFutbol.push({ 
                    nombre: "FC Cartagena", 
                    tipo: "clasificacion", 
                    origen: "LaPreferente", 
                    tabla: tablaCartagena 
                });
                console.log("✅ Clasificación 1ª RFEF (Gr. 2) extraída");
            }
        } catch (e) { 
            console.error("❌ Error Clasificación FC Cartagena:", e); 
        } finally {
            await pageClasCartagena.close();
        }

        // --- 2.2 CLASIFICACIÓN EIBAR B ---
        const pageClasEibar = await browser.newPage();
        try {
            // URL de LaPreferente para el Eibar B
            await pageClasEibar.goto("https://www.lapreferente.com/E5847C22299-19/sd-eibar-b", { waitUntil: 'networkidle2' });
            
            const tablaEibar = await pageClasEibar.evaluate(() => {
                // Buscamos la tabla con el ID específico
                const tabla = document.getElementById('tableClasif');
                if (!tabla) return [];

                // Obtenemos las filas del cuerpo de la tabla
                const filas = Array.from(tabla.querySelectorAll('tbody tr'));
                
                return filas.map(f => {
                    const tds = f.querySelectorAll('td');
                    
                    // Verificamos que la fila tenga al menos 10 celdas para evitar errores
                    if (tds.length < 10) return null;

                    // Mapeo según tus instrucciones: 3º (índice 2) y 5º-10º (índices 4-9)
                    // Nota: En LaPreferente las columnas suelen ser PJ, G, E, P, GF, GC...
                    return {
                        nombre: tds[2]?.innerText.trim(),         // 3º TD: Nombre Equipo
                        Jugados: tds[4]?.innerText.trim(),        // 5º TD: Partidos Jugados
                        Ganados: tds[5]?.innerText.trim(),        // 6º TD: Ganados
                        Empatados: tds[6]?.innerText.trim(),      // 7º TD: Empatados
                        Perdidos: tds[7]?.innerText.trim(),       // 8º TD: Perdidos
                        GolesFavor: tds[8]?.innerText.trim(),     // 9º TD: Goles a Favor
                        GolesContra: tds[9]?.innerText.trim()      // 10º TD: Goles en Contra
                    };
                }).filter(e => e !== null);
            });

            if (tablaEibar.length > 0) {
                tablaEibar.forEach(element => {
                    if (element.nombre == "S.D. Eibar B") {
                        jEibarB = element.Jugados;
                    }
                });
                // Lo guardamos en tu array de base de datos
                baseDeDatosFutbol.push({ 
                    nombre: "Eibar B", 
                    tipo: "clasificacion", 
                    origen: "LaPreferente", 
                    tabla: tablaEibar 
                });
                console.log("✅ Clasificación 2ª RFEF (Gr. 2) extraída");
            }
        } catch (e) { 
            console.error("❌ Error Clasificación Eibar B:", e); 
        } finally {
            await pageClasEibar.close();
        }

        // --- 2.3 CLASIFICACIÓN CD DERIO ---
        const pageClasDerio = await browser.newPage();
        try {
            // URL de LaPreferente para el Eibar B
            await pageClasDerio.goto("https://www.lapreferente.com/E10466C22283-19/cd-derio", { waitUntil: 'networkidle2' });
            
            const tablaDerio = await pageClasDerio.evaluate(() => {
                // Buscamos la tabla con el ID específico
                const tabla = document.getElementById('tableClasif');
                if (!tabla) return [];

                // Obtenemos las filas del cuerpo de la tabla
                const filas = Array.from(tabla.querySelectorAll('tbody tr'));
                
                return filas.map(f => {
                    const tds = f.querySelectorAll('td');
                    
                    // Verificamos que la fila tenga al menos 10 celdas para evitar errores
                    if (tds.length < 10) return null;

                    // Mapeo según tus instrucciones: 3º (índice 2) y 5º-10º (índices 4-9)
                    // Nota: En LaPreferente las columnas suelen ser PJ, G, E, P, GF, GC...
                    return {
                        nombre: tds[2]?.innerText.trim(),         // 3º TD: Nombre Equipo
                        Jugados: tds[4]?.innerText.trim(),        // 5º TD: Partidos Jugados
                        Ganados: tds[5]?.innerText.trim(),        // 6º TD: Ganados
                        Empatados: tds[6]?.innerText.trim(),      // 7º TD: Empatados
                        Perdidos: tds[7]?.innerText.trim(),       // 8º TD: Perdidos
                        GolesFavor: tds[8]?.innerText.trim(),     // 9º TD: Goles a Favor
                        GolesContra: tds[9]?.innerText.trim()      // 10º TD: Goles en Contra
                    };
                }).filter(e => e !== null);
            });

            if (tablaDerio.length > 0) {
                tablaDerio.forEach(element => {
                    if (element.nombre == "C.D. Derio") {
                        jDerio = element.Jugados;
                    }
                });
                // Lo guardamos en tu array de base de datos
                baseDeDatosFutbol.push({ 
                    nombre: "CD Derio", 
                    tipo: "clasificacion", 
                    origen: "LaPreferente", 
                    tabla: tablaDerio 
                });
                console.log("✅ Clasificación 3ª RFEF (Gr. 4) extraída");
            }
        } catch (e) { 
            console.error("❌ Error Clasificación CD Derio:", e); 
        } finally {
            await pageClasDerio.close();
        }

        // --- 2.4 CLASIFICACIÓN INDARTSU ---
        const pageClasInd = await browser.newPage();
        try {
            await pageClasInd.goto("https://www.fvf-bff.eus/pnfg/NPcd/NFG_VisClasificacion?cod_primaria=1000120&codcompeticion=22620319&codgrupo=22682897&cod_agrupacion=1773563", { waitUntil: 'networkidle2' });
            const tablaClas = await pageClasInd.evaluate(() => {
                // Seleccionamos la tabla por sus clases exactas
                const tabla = document.querySelector('table.table.table-bordered.table-striped');
                if (!tabla) return [];

                const filas = Array.from(tabla.querySelectorAll('tbody tr'));
                return filas.map(f => {
                    const tds = f.querySelectorAll('td');
                    // Verificamos que existan suficientes celdas
                    if (tds.length < 14) return null;

                    return {
                        nombre: tds[2]?.innerText.trim(),      // 3º TD (índice 2)
                        JugadosCasa: tds[4]?.innerText.trim(),          // 5º TD (índice 4)
                        GanadosCasa: tds[5]?.innerText.trim(),           // 6º
                        EmpatadosCasa: tds[6]?.innerText.trim(),           // 7º
                        PerdidosCasa: tds[7]?.innerText.trim(),           // 8º
                        JugadosFuera: tds[8]?.innerText.trim(),          // 9º
                        GanadosFuera: tds[9]?.innerText.trim(),          // 10º
                        EmpatadosFuera: tds[10]?.innerText.trim(),       // 11º
                        PerdidosFuera: tds[11]?.innerText.trim(),  // 12º
                        GolesFavor: tds[12]?.innerText.trim(), // 13º
                        GolesContra: tds[13]?.innerText.trim()       // 14º TD (índice 13)
                    };
                }).filter(e => e !== null);
            });
            if (tablaClas.length > 0) {
                baseDeDatosFutbol.push({ nombre: "Indartsu", tipo: "clasificacion", origen: "Federacion", tabla: tablaClas });
                console.log("✅ Clasificación 1ª REG (Gr. 2) extraída");
            }
        } catch (e) { console.error("❌ Error Clasificación Indartsu"); }
        await pageClasInd.close();

        // --- 2.5 EXTRACCIÓN PARTIDOS SOFASCORE (Derio, Eibar B, Cartagena) ---
        const urlsSofa = [
            { id: "derio", url: "https://www.sofascore.com/es/football/team/cd-derio/488513" },
            { id: "eibar_b", url: "https://www.sofascore.com/es/football/team/sd-eibar-b/750559" },
            { id: "cartagena", url: "https://www.sofascore.com/es/football/team/fc-cartagena/24329" }
        ];

        for (const s of urlsSofa) {
            const page = await browser.newPage();
            try {
                // Mantenemos tu Viewport específico
                await page.setViewport({ width: 800, height: 731 });
                
                // El User Agent es vital para que SofaScore no bloquee la segunda y tercera carga
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

                await page.goto(s.url, { waitUntil: 'networkidle2', timeout: 60000 });

                // Aceptar cookies (siempre con un try/catch pequeño)
                try {
                    const btnCookies = await page.waitForSelector('button[id*="onetrust-accept"], button.fc-cta-consent', { timeout: 4000 });
                    await btnCookies.click();
                } catch (e) {}

                // 1. Localizar el botón de "Partidos" de forma más flexible
                // A veces el data-testid tarda en estar activo. Usamos una función de evaluación.
                const selectorPartidos = 'button[data-testid="tab-matches"]';
                await page.waitForSelector(selectorPartidos, { visible: true, timeout: 15000 });

                // 2. Clic forzado mediante JS (más fiable en viewports pequeños donde otros elementos pueden solapar)
                await page.evaluate((sel) => {
                    const btn = document.querySelector(sel);
                    if (btn) {
                        btn.scrollIntoView();
                        btn.click();
                    }
                }, selectorPartidos);
                
                // 3. Esperar a que el contenedor de partidos aparezca realmente
                await page.waitForSelector('a[data-id]', { timeout: 15000 });
                await delay(3000); // Pausa necesaria para que carguen los <bdi> internos

                const partidosExtraidos = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a[data-id]'));
                    return links.map(link => {
                        const bdis = Array.from(link.querySelectorAll('bdi'))
                                        .map(b => b.innerText.trim())
                                        .filter(t => t.length > 0);
                        
                        const indexHora = bdis.findIndex(t => t.includes(':') || (t.includes('-') && /\d/.test(t)));
                        
                        return {
                            fecha: bdis[0] || "---",
                            resultado_hora: indexHora !== -1 ? bdis[indexHora] : "---",
                            equipo_1: indexHora !== -1 ? bdis[indexHora + 1] : "---",
                            equipo_2: indexHora !== -1 ? bdis[indexHora + 2] : "---"
                        };
                    });
                });

                if (partidosExtraidos.length > 0) {
                    baseDeDatosFutbol.push({
                        nombre: s.id,
                        tipo: "lista_partidos",
                        origen: "SofaScore",
                        partidos: partidosExtraidos
                    });
                    console.log(`✅ Partidos de ${s.id} extraídos (${partidosExtraidos.length})`);
                } else {
                    console.log(`⚠️ No se detectaron partidos en el HTML de ${s.id}`);
                }

            } catch (e) { 
                console.error(`❌ Error SofaScore partidos ${s.id}:`, e.message); 
            } finally { 
                await page.close(); 
            }
        }

        // --- 3. JUGADORES (CEROACERO) ---
const jugadores = [
    { nombre: "Jon Garcia", url: "https://www.ceroacero.es/jugador/jon-garcia/2773981/resultados?epoca_id=155&tpstats=club&ps=1" },
    { nombre: "Ekain Etxebarria", url: "https://www.ceroacero.es/jugador/ekain-etxebarria/2507672/resultados?epoca_id=155&tpstats=club&ps=1" },
    { nombre: "Eneko Ebro", url: "https://www.ceroacero.es/jugador/eneko-ebro/1035277/resultados?group_tpstats=epoca&tpstats=all&grp=1&edicao_id=202631&epoca_id=155&eve=&id=1035277&op=zoomstats" }
];

for (const j of jugadores) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    try {
        await page.goto(j.url, { waitUntil: 'networkidle2', timeout: 60000 });

        // Esperamos a la tabla específica de Ceroacero
        await page.waitForSelector('table.zztable.stats', { timeout: 20000 });

        const stats = await page.evaluate((jugadorActual, jE, jD, jC) => {
            const res = { nombre: jugadorActual.nombre, PJ: "0", NJ: "0", Tit: "0", Sup: "0", Goles: "0", Am: "0", Roj: "0" };
            
            const tabla = document.querySelector('table.zztable.stats');
            if (!tabla) return res;

            // Buscamos la fila de totales (clase .totals)
            const filas = Array.from(tabla.querySelectorAll('tr'));
            const filaTotal = filas.find(f => f.querySelector('.totals'));

            if (filaTotal) {
                const celdas = Array.from(filaTotal.querySelectorAll('td'));

                // Mapeo según el HTML de Ceroacero
                res.PJ = celdas[1]?.innerText.trim() || "0";
                res.Tit = celdas[7]?.innerText.trim() || "0";
                res.Sup = celdas[8]?.innerText.trim() || "0";
                
                // Lógica especial para Jon Garcia (Goles en columna 5 tras split) o resto (columna 9)
                if (jugadorActual.nombre === "Jon Garcia") {
                    const textoGoles = celdas[5]?.innerText.trim() || "0-0";
                    res.Goles = textoGoles.split("-")[1] || "0";
                } else {
                    res.Goles = celdas[9]?.innerText.trim() || "0";
                }

                res.Am = celdas[12]?.innerText.trim() || "0";
                res.Roj = celdas[14]?.innerText.trim() || "0";

                // Cálculo de NJ (No Jugados)
                const pjInt = parseInt(res.PJ, 10) || 0;
                let jT = 0;
                if (jugadorActual.nombre === "Ekain Etxebarria") jT = jE;
                else if (jugadorActual.nombre === "Jon Garcia") jT = jD; // Corregido: "Jon Garcia" sin tilde para coincidir con tu array
                else if (jugadorActual.nombre === "Eneko Ebro") jT = jC;

                res.NJ = Math.max(0, jT - pjInt).toString();
            }
            return res;
        }, j, jEibarB, jDerio, jCartagena); // Inyectamos todas las variables necesarias

        baseDeDatosFutbol.push({ 
            tipo: "jugador", 
            origen: "Ceroacero", 
            ...stats 
        });
        
        console.log(`✅ Datos de jugador extraídos: ${j.nombre} (PJ: ${stats.PJ})`);

    } catch (e) { 
        console.error(`❌ Error Jugador ${j.nombre}: `, e.message); 
    } finally {
        await page.close();
    }
}

        // --- 4. JUGADORES (FEDERACIÓN) ---
        const jugadoresFED = [
            { nombre: "Gaizka Miralles", url: "https://www.fvf-bff.eus/pnfg/NPcd/NFG_EstadisticasJugador?cod_primaria=3000328&jugador=74876&codacta=9983308" },
            { nombre: "Peio Manrique", url: "https://www.fvf-bff.eus/pnfg/NPcd/NFG_EstadisticasJugador?cod_primaria=3000328&jugador=74062&codacta=9983308" },
            { nombre: "Jon Hermida", url: "https://www.fvf-bff.eus/pnfg/NPcd/NFG_EstadisticasJugador?cod_primaria=3000328&jugador=70074&codacta=9983241" }
        ];

        for (const j of jugadoresFED) {
            const page = await browser.newPage();
            try {
                await page.goto(j.url, { waitUntil: 'networkidle2' });
                const stats = await page.evaluate((n, jI) => {
                    const res = { nombre: n, PJ: "0", NJ: "0", Tit: "0", Sup: "0", Goles: "0", Am: "0", Roj: "0" };
                    const celdas = Array.from(document.querySelectorAll('td'));
                    let biko = 0, gorria = 0;
                    celdas.forEach((td, i) => {
                        const txt = td.innerText.trim();
                        const val = celdas[i + 1]?.innerText.trim() || "0";
                        if (txt === "Jokatutakoak") res.PJ = val;
                        if (txt === "Hamaikakoan") res.Tit = val;
                        if (txt === "Ordezkoa") res.Sup = val;
                        if (txt === "Guztira") res.Goles = val;
                        if (txt === "Txartel horia") res.Am = val;
                        if (txt === "Txartel horia bikoitza") biko = parseInt(val) || 0;
                        if (txt === "Txartel gorria") gorria = parseInt(val) || 0;
                    });
                    res.Roj = (biko + gorria).toString();
                    res.NJ = Math.max(0, jI - parseInt(res.PJ)).toString();
                    return res;
                }, j.nombre, jIndartsu);
                baseDeDatosFutbol.push({ tipo: "jugador", origen: "Federacion", ...stats });
            } catch (e) { console.error(`❌ Error Jugador ${j.nombre}`); }
            await page.close();
        }

        // --- 5. SUBIDA A FIREBASE ---
        if (baseDeDatosFutbol.length > 0) {
            const batch = db.batch();
            
            /**
             * EXPLICACIÓN REGEX:
             * ^\d+ : Empieza por uno o más dígitos
             * \s+-\s+ : Seguido de uno o más espacios, un guion, y uno o más espacios
             * \d+ : Seguido de uno o más dígitos
             * (\s*[GPE])? : Opcionalmente, cero o más espacios y una de las letras G, P o E
             * $ : Fin de la cadena
             */
            const regexResultadoPersonalizado = /^\d+\s+-\s+\d+(\s*[GPE])?$/;

            baseDeDatosFutbol.forEach(dato => {
                const customId = crearIdDoc(dato.tipo, dato.nombre);
                const docRef = db.collection('seguimiento_futbol').doc(customId);

                if (dato.tipo === "equipo") {
                    const resUltimo = dato.ultimo?.resultado || "";
                    if (regexResultadoPersonalizado.test(resUltimo)) {
                        const { jornadaNum, origen, tipo, ...datosLimpios } = dato;
                        batch.set(docRef, datosLimpios, { merge: true });
                        console.log(`✅ ${dato.nombre} cumple el filtro (${resUltimo}). Subiendo...`);
                    } else {
                        console.log(`⚠️ ${dato.nombre} NO cumple el filtro (${resUltimo}). Ignorado.`);
                    }
                } else {
                    const { jornadaNum, origen, tipo, ...datosLimpios } = dato;
                    batch.set(docRef, datosLimpios, { merge: true });
                }
            });

            await batch.commit();
            console.log("✅ Firebase finalizado!");
        }

    } catch (error) { console.error("❌ Error General:", error); }
    finally { await browser.close(); }
}

scriptIntegradoFutbol();