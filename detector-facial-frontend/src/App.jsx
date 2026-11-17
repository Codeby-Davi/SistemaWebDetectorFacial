import { useEffect, useRef, useState } from "react";
import "./App.css";

const API_URL = "http://localhost:8000/api/detectar";

export default function App() {
  const videoRef = useRef(null);
  const canvasOcultoRef = useRef(null);
  const canvasOverlayRef = useRef(null);

  const procesandoRef = useRef(false);
  const cajaObjetivoRef = useRef(null);
  const cajaSuavizadaRef = useRef(null);
  const datosDeteccionRef = useRef(null);
  const modoActivoRef = useRef("rostro");

  const [modoActivo, setModoActivo] = useState("rostro");
  const [estadoCamara, setEstadoCamara] = useState("solicitando");
  const [camaraPausada, setCamaraPausada] = useState(false);
  const [apiConectada, setApiConectada] = useState(false);
  const [latenciaMs, setLatenciaMs] = useState(0);
  const [resultado, setResultado] = useState({
    rostro_detectado: false,
    con_lentes: false,
    con_mascarilla: false,
    confianza: 0,
  });

  const cambiarModo = (nuevoModo) => {
    setModoActivo(nuevoModo);
    modoActivoRef.current = nuevoModo;
    // Si el video está pausado, analizamos de inmediato la imagen congelada con el nuevo módulo
    if (camaraPausada) {
      enviarFrameAlBackend();
    }
  };

  useEffect(() => {
    let stream = null;
    async function iniciarCamara() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
        setEstadoCamara("activa");
      } catch (err) {
        console.error("Error de cámara:", err);
        setEstadoCamara("error");
      }
    }
    iniciarCamara();
    return () => {
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (estadoCamara !== "activa" || camaraPausada) return;
    const intervalo = setInterval(() => enviarFrameAlBackend(), 100);
    return () => clearInterval(intervalo);
  }, [estadoCamara, camaraPausada]);

  const enviarFrameAlBackend = async () => {
    const video = videoRef.current;
    const canvas = canvasOcultoRef.current;
    if (procesandoRef.current || !video || !canvas || video.readyState < 2) return;

    procesandoRef.current = true;
    const inicio = performance.now();

    try {
      const anchoEnvio = 320;
      const altoEnvio = Math.round((video.videoHeight / video.videoWidth) * anchoEnvio) || 240;
      canvas.width = anchoEnvio;
      canvas.height = altoEnvio;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, anchoEnvio, altoEnvio);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
      const formData = new FormData();
      formData.append("file", blob, "frame.jpg");
      formData.append("modo", modoActivoRef.current);

      const respuesta = await fetch(API_URL, { method: "POST", body: formData });
      if (!respuesta.ok) throw new Error("Error HTTP");

      const data = await respuesta.json();
      setApiConectada(true);
      setLatenciaMs(Math.round(performance.now() - inicio));
      setResultado(data);
      datosDeteccionRef.current = data;

      if (data.rostro_detectado && data.caja) {
        cajaObjetivoRef.current = data.caja;
      } else {
        cajaObjetivoRef.current = null;
      }
    } catch {
      setApiConectada(false);
      cajaObjetivoRef.current = null;
    } finally {
      procesandoRef.current = false;
    }
  };

  useEffect(() => {
    let animationFrameId;

    const renderizarOverlay = () => {
      const video = videoRef.current;
      const overlay = canvasOverlayRef.current;

      if (video && overlay && video.videoWidth > 0) {
        if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
          overlay.width = video.videoWidth;
          overlay.height = video.videoHeight;
        }

        const ctx = overlay.getContext("2d");
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        const objetivo = cajaObjetivoRef.current;

        // Mantenemos el recuadro visible incluso cuando camaraPausada es true
        if (!objetivo) {
          cajaSuavizadaRef.current = null;
        } else if (!cajaSuavizadaRef.current || camaraPausada) {
          cajaSuavizadaRef.current = { ...objetivo };
        } else {
          const f = 0.3;
          cajaSuavizadaRef.current.x += (objetivo.x - cajaSuavizadaRef.current.x) * f;
          cajaSuavizadaRef.current.y += (objetivo.y - cajaSuavizadaRef.current.y) * f;
          cajaSuavizadaRef.current.w += (objetivo.w - cajaSuavizadaRef.current.w) * f;
          cajaSuavizadaRef.current.h += (objetivo.h - cajaSuavizadaRef.current.h) * f;
        }

        if (cajaSuavizadaRef.current && datosDeteccionRef.current) {
          const { x, y, w, h } = cajaSuavizadaRef.current;
          const data = datosDeteccionRef.current;
          const modo = modoActivoRef.current;

          const drawX = (1 - (x + w)) * overlay.width;
          const drawY = y * overlay.height;
          const drawW = w * overlay.width;
          const drawH = h * overlay.height;

          // 1. Recuadro base del rostro
          ctx.strokeStyle = modo === "rostro" ? "#10b981" : "rgba(148, 163, 184, 0.45)";
          ctx.lineWidth = modo === "rostro" ? 3 : 1.5;
          ctx.beginPath();
          ctx.roundRect(drawX, drawY, drawW, drawH, 10);
          ctx.stroke();

          // 2. Recuadro específico del apartado activo
          if (data.caja_detalle && (modo === "lentes" || modo === "mascarilla")) {
            const det = data.caja_detalle;
            const detX = (1 - (det.x + det.w)) * overlay.width;
            const detY = det.y * overlay.height;
            const detW = det.w * overlay.width;
            const detH = det.h * overlay.height;

            const activoDetalle = modo === "lentes" ? data.con_lentes : data.con_mascarilla;
            ctx.strokeStyle = activoDetalle ? "#10b981" : "#3b82f6";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.roundRect(detX, detY, detW, detH, 8);
            ctx.stroke();
          }

          // 3. Etiqueta dinámica
          let texto = "Rostro Detectado";
          let colorTexto = "#34d399";

          if (modo === "lentes") {
            texto = data.con_lentes ? "✔ Con Lentes" : "✖ Sin Lentes";
            colorTexto = data.con_lentes ? "#34d399" : "#60a5fa";
          } else if (modo === "mascarilla") {
            texto = data.con_mascarilla ? "✔ Con Mascarilla / Cubierto" : "✖ Sin Mascarilla";
            colorTexto = data.con_mascarilla ? "#34d399" : "#60a5fa";
          }

          if (camaraPausada) {
            texto += " (Pausado)";
          }

          ctx.font = "600 15px system-ui, sans-serif";
          const anchoTexto = ctx.measureText(texto).width + 20;
          const etiquetaY = Math.max(8, drawY - 34);

          ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
          ctx.beginPath();
          ctx.roundRect(drawX, etiquetaY, anchoTexto, 28, 6);
          ctx.fill();

          ctx.fillStyle = colorTexto;
          ctx.fillText(texto, drawX + 10, etiquetaY + 19);
        }
      }

      animationFrameId = requestAnimationFrame(renderizarOverlay);
    };

    animationFrameId = requestAnimationFrame(renderizarOverlay);
    return () => cancelAnimationFrame(animationFrameId);
  }, [camaraPausada]);

  const alternarPausa = () => {
    const video = videoRef.current;
    if (!video) return;
    if (camaraPausada) {
      video.play();
      setCamaraPausada(false);
    } else {
      video.pause();
      setCamaraPausada(true);
      // Analiza la imagen congelada inmediatamente al pausar
      enviarFrameAlBackend();
    }
  };

  return (
    <div className="layout">
      <header className="topbar">
        <div>
          <h1>Visión Artificial • Detección Facial</h1>
          <p className="subtitulo">Módulos independientes de análisis en tiempo real</p>
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            onClick={() => cambiarModo("rostro")}
            className="btn-control"
            style={{
              background: modoActivo === "rostro" ? "#10b981" : "#1e293b",
              color: modoActivo === "rostro" ? "#052e16" : "#f1f5f9",
              borderColor: modoActivo === "rostro" ? "#10b981" : "#334155",
            }}
          >
            1. Detector de Rostro
          </button>
          <button
            onClick={() => cambiarModo("lentes")}
            className="btn-control"
            style={{
              background: modoActivo === "lentes" ? "#10b981" : "#1e293b",
              color: modoActivo === "lentes" ? "#052e16" : "#f1f5f9",
              borderColor: modoActivo === "lentes" ? "#10b981" : "#334155",
            }}
          >
            2. Detector de Lentes
          </button>
          <button
            onClick={() => cambiarModo("mascarilla")}
            className="btn-control"
            style={{
              background: modoActivo === "mascarilla" ? "#10b981" : "#1e293b",
              color: modoActivo === "mascarilla" ? "#052e16" : "#f1f5f9",
              borderColor: modoActivo === "mascarilla" ? "#10b981" : "#334155",
            }}
          >
            3. Mascarilla / Mano
          </button>
        </div>

        <div className={`pill-conexion ${apiConectada ? "online" : "offline"}`}>
          <span className="punto"></span>
          {apiConectada ? `API Conectada (${latenciaMs} ms)` : "Esperando Backend Python..."}
        </div>
      </header>

      <main className="contenido-principal">
        <section className="visor-card">
          <div className="video-wrapper">
            {estadoCamara === "solicitando" && (
              <div className="mensaje-estado">Solicitando acceso a la cámara...</div>
            )}
            {estadoCamara === "error" && (
              <div className="mensaje-estado error">
                No se pudo acceder a la cámara. Verifica los permisos del navegador.
              </div>
            )}

            <video ref={videoRef} autoPlay playsInline muted className="video-espejo" />
            <canvas ref={canvasOverlayRef} className="canvas-overlay" />
            <canvas ref={canvasOcultoRef} style={{ display: "none" }} />
          </div>

          <div className="controles-barra">
            <button onClick={alternarPausa} className="btn-control" disabled={estadoCamara !== "activa"}>
              {camaraPausada ? "▶ Reanudar Detección" : "⏸ Pausar Cámara"}
            </button>
            <span className="info-confianza">
              Confianza del modelo:{" "}
              <strong>
                {resultado.rostro_detectado ? `${Math.round((resultado.confianza || 0) * 100)}%` : "—"}
              </strong>
            </span>
          </div>
        </section>

        <aside className="panel-resultados">
          <h2>
            {modoActivo === "rostro" && "Módulo: Detección de Rostro"}
            {modoActivo === "lentes" && "Módulo: Detección de Lentes"}
            {modoActivo === "mascarilla" && "Módulo: Mascarilla / Mano"}
          </h2>

          {modoActivo === "rostro" && (
            <TarjetaIndicador
              titulo="Estado del Rostro"
              valor={resultado.rostro_detectado ? "Rostro Detectado" : "Buscando rostro..."}
              activo={resultado.rostro_detectado}
            />
          )}

          {modoActivo === "lentes" && (
            <>
              <TarjetaIndicador
                titulo="Rostro Base"
                valor={resultado.rostro_detectado ? "Localizado" : "Buscando..."}
                activo={resultado.rostro_detectado}
              />
              <TarjetaIndicador
                titulo="Lectura de Lentes"
                valor={
                  !resultado.rostro_detectado
                    ? "Sin lectura"
                    : resultado.con_lentes
                    ? "Con Lentes"
                    : "Sin Lentes"
                }
                activo={resultado.rostro_detectado && resultado.con_lentes}
                neutro={!resultado.rostro_detectado}
              />
            </>
          )}

          {modoActivo === "mascarilla" && (
            <>
              <TarjetaIndicador
                titulo="Rostro Base"
                valor={resultado.rostro_detectado ? "Localizado" : "Buscando..."}
                activo={resultado.rostro_detectado}
              />
              <TarjetaIndicador
                titulo="Lectura de Mascarilla / Mano"
                valor={
                  !resultado.rostro_detectado
                    ? "Sin lectura"
                    : resultado.con_mascarilla
                    ? "Mascarilla / Cubierto"
                    : "Descubierto"
                }
                activo={resultado.rostro_detectado && resultado.con_mascarilla}
                neutro={!resultado.rostro_detectado}
              />
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

function TarjetaIndicador({ titulo, valor, activo, neutro = false }) {
  const claseEstado = neutro ? "neutro" : activo ? "positivo" : "negativo";
  return (
    <div className={`indicador-card ${claseEstado}`}>
      <span className="indicador-titulo">{titulo}</span>
      <strong className="indicador-valor">{valor}</strong>
    </div>
  );
}