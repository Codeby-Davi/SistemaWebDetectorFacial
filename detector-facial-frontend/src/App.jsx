import { useEffect, useRef, useState } from "react";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000/api/detectar";

const MODULOS = [
  {
    id: "rostro",
    numero: "01",
    titulo: "Detector de Rostro",
    descripcion: "Localización base de malla facial (468 puntos)",
  },
  {
    id: "lentes",
    numero: "02",
    titulo: "Detector de Lentes",
    descripcion: "Análisis estructural de puente, aros y patillas",
  },
  {
    id: "mascarilla",
    numero: "03",
    titulo: "Mascarilla / Mano",
    descripcion: "Detección de oclusión facial y proximidad",
  },
];

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
    if (camaraPausada) {
      enviarFrameAlBackend();
    }
  };

  useEffect(() => {
    let stream = null;
    let cancelado = false;

    async function iniciarCamara() {
      try {
        // Pequeña pausa de 150ms para que Windows libere la webcam tras un Hot Reload de Vite
        await new Promise((r) => setTimeout(r, 150));
        if (cancelado) return;

        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });

        if (cancelado) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.onloadedmetadata = async () => {
            try {
              await video.play();
              setEstadoCamara("activa");
            } catch (playErr) {
              console.error("Error al reproducir video:", playErr);
            }
          };
        }
      } catch (err) {
        console.error("Error de cámara:", err);
        if (!cancelado) setEstadoCamara("error");
      }
    }

    iniciarCamara();

    return () => {
      cancelado = true;
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

          // 1. Recuadro base del rostro (Jade #7B9669 o Salvia suave #BAC8B1)
          ctx.strokeStyle = modo === "rostro" ? "#7B9669" : "rgba(186, 200, 177, 0.75)";
          ctx.lineWidth = modo === "rostro" ? 3 : 1.75;
          ctx.beginPath();
          ctx.roundRect(drawX, drawY, drawW, drawH, 12);
          ctx.stroke();

          // 2. Recuadro específico del apartado activo
          if (data.caja_detalle && (modo === "lentes" || modo === "mascarilla")) {
            const det = data.caja_detalle;
            const detX = (1 - (det.x + det.w)) * overlay.width;
            const detY = det.y * overlay.height;
            const detW = det.w * overlay.width;
            const detH = det.h * overlay.height;

            const activoDetalle = modo === "lentes" ? data.con_lentes : data.con_mascarilla;
            ctx.strokeStyle = activoDetalle ? "#7B9669" : "#6C8480";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.roundRect(detX, detY, detW, detH, 8);
            ctx.stroke();
          }

          // 3. Etiqueta dinámica con fondo Bosque Oscuro (#404E3B)
          let texto = "Rostro Detectado";
          let colorBadge = "#7B9669";

          if (modo === "lentes") {
            texto = data.con_lentes ? "✔ Con Lentes" : "✖ Sin Lentes";
            colorBadge = data.con_lentes ? "#7B9669" : "#6C8480";
          } else if (modo === "mascarilla") {
            texto = data.con_mascarilla ? "✔ Mascarilla / Cubierto" : "✖ Descubierto";
            colorBadge = data.con_mascarilla ? "#7B9669" : "#6C8480";
          }

          if (camaraPausada) {
            texto += " • Pausa";
          }

          ctx.font = "600 14px system-ui, -apple-system, sans-serif";
          const anchoTexto = ctx.measureText(texto).width + 24;
          const etiquetaY = Math.max(10, drawY - 36);

          ctx.fillStyle = "#404E3B";
          ctx.beginPath();
          ctx.roundRect(drawX, etiquetaY, anchoTexto, 28, 8);
          ctx.fill();

          ctx.strokeStyle = colorBadge;
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = "#E6E6E6";
          ctx.fillText(texto, drawX + 12, etiquetaY + 19);
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
      enviarFrameAlBackend();
    }
  };

  const moduloActualInfo = MODULOS.find((m) => m.id === modoActivo);
  const porcentajeConfianza = resultado.rostro_detectado
    ? Math.round((resultado.confianza || 0) * 100)
    : 0;

  return (
    <div className="app-shell">
      {/* Barra Lateral Izquierda (#404E3B) */}
      <aside className="sidebar">
        <div className="brand-box">
          <div className="brand-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7V5a2 2 0 0 1 2-2h2" />
              <path d="M17 3h2a2 2 0 0 1 2 2v2" />
              <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
              <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
              <circle cx="12" cy="10" r="3" />
              <path d="M7 18a5 5 0 0 1 10 0" />
            </svg>
          </div>
          <div>
            <span className="brand-tag">Detector Artificial</span>
            <h1 className="brand-title">Grupo #4</h1>
          </div>
        </div>

        <nav className="nav-modulos" aria-label="Módulos de detección">
          <span className="nav-label">MÓDULOS DE ANÁLISIS</span>
          {MODULOS.map((mod) => {
            const activo = modoActivo === mod.id;
            return (
              <button
                key={mod.id}
                onClick={() => cambiarModo(mod.id)}
                className={`nav-item ${activo ? "activo" : ""}`}
              >
                <span className="nav-num">{mod.numero}</span>
                <div className="nav-texto">
                  <strong>{mod.titulo}</strong>
                  <small>{mod.descripcion}</small>
                </div>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className={`status-banner ${apiConectada ? "online" : "offline"}`}>
            <span className="status-dot"></span>
            <div className="status-info">
              <strong>{apiConectada ? "Servidor Activo" : "Sin Conexión a Python"}</strong>
              <span>{apiConectada ? `Respuesta en ${latenciaMs} ms` : "Servidor desconectado"}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Área Principal (#E6E6E6) */}
      <main className="workspace">
        <header className="workspace-header">
          <div>
            <div className="breadcrumb">
              Módulo {moduloActualInfo.numero} / <span>Análisis en Tiempo Real</span>
            </div>
            <h2>{moduloActualInfo.titulo}</h2>
          </div>

          <div className="header-actions">
            <button
              onClick={alternarPausa}
              className={`btn-accion ${camaraPausada ? "reanudar" : ""}`}
              disabled={estadoCamara !== "activa"}
            >
              {camaraPausada ? (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  Reanudar Cámara
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                  Pausar Captura
                </>
              )}
            </button>
          </div>
        </header>

        {/* Contenedor del Visor Óptico */}
        <section className="stage-card">
          <div className="video-frame">
            {/* Guías estéticas de encuadre en las esquinas */}
            <span className="corner tl"></span>
            <span className="corner tr"></span>
            <span className="corner bl"></span>
            <span className="corner br"></span>

            {estadoCamara === "solicitando" && (
              <div className="cam-placeholder">Solicitando acceso a la cámara web...</div>
            )}
            {estadoCamara === "error" && (
              <div className="cam-placeholder error">
                No se pudo acceder a la cámara. Revisa los permisos de tu navegador.
              </div>
            )}

            <video ref={videoRef} autoPlay playsInline muted className="video-feed" />
            <canvas ref={canvasOverlayRef} className="overlay-canvas" />
            <canvas ref={canvasOcultoRef} style={{ display: "none" }} />

            <div className="live-pill">
              <span className={`rec-dot ${camaraPausada ? "paused" : ""}`}></span>
              {camaraPausada ? "IMAGEN CONGELADA" : "EN VIVO • 60 FPS"}
            </div>
          </div>
        </section>

        {/* Fila Inferior de Diagnóstico y Telemetría */}
        <section className="metrics-grid">
          <div className={`metric-card ${resultado.rostro_detectado ? "jade" : "slate"}`}>
            <span className="metric-label">Rostro Base (MediaPipe)</span>
            <strong className="metric-value">
              {resultado.rostro_detectado ? "Localizado" : "Buscando sujeto..."}
            </strong>
            <span className="metric-sub">Seguimiento facial activo</span>
          </div>

          {modoActivo === "rostro" && (
            <div className={`metric-card ${resultado.rostro_detectado ? "jade" : "neutral"}`}>
              <span className="metric-label">Estado de Captura</span>
              <strong className="metric-value">
                {resultado.rostro_detectado ? "Encuadre Óptimo" : "Sin Sujeto"}
              </strong>
              <span className="metric-sub">Listo para inspección de atributos</span>
            </div>
          )}

          {modoActivo === "lentes" && (
            <div
              className={`metric-card ${
                !resultado.rostro_detectado ? "neutral" : resultado.con_lentes ? "jade" : "slate"
              }`}
            >
              <span className="metric-label">Diagnóstico de Lentes</span>
              <strong className="metric-value">
                {!resultado.rostro_detectado
                  ? "Esperando rostro"
                  : resultado.con_lentes
                  ? "Con Lentes"
                  : "Sin Lentes"}
              </strong>
              <span className="metric-sub">Puente nasal, aros y sienes</span>
            </div>
          )}

          {modoActivo === "mascarilla" && (
            <div
              className={`metric-card ${
                !resultado.rostro_detectado ? "neutral" : resultado.con_mascarilla ? "jade" : "slate"
              }`}
            >
              <span className="metric-label">Diagnóstico de Mascarilla / Mano</span>
              <strong className="metric-value">
                {!resultado.rostro_detectado
                  ? "Esperando rostro"
                  : resultado.con_mascarilla
                  ? "Mascarilla / Cubierto"
                  : "Rostro Descubierto"}
              </strong>
              <span className="metric-sub">Análisis cromático YCrCb + Hands</span>
            </div>
          )}

          <div className="metric-card confidence-card">
            <div className="conf-header">
              <span className="metric-label">Precisión del Modelo</span>
              <strong className="conf-number">
                {resultado.rostro_detectado ? `${porcentajeConfianza}%` : "0%"}
              </strong>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${porcentajeConfianza}%` }}
              ></div>
            </div>
            <span className="metric-sub">OpenCV + MediaPipe FaceMesh</span>
          </div>
        </section>
      </main>
    </div>
  );
}