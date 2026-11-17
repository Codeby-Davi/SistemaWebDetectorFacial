import { useEffect, useRef, useState } from "react";
import "./App.css";

const API_URL = "http://localhost:8000/api/detectar";

export default function App() {
  const videoRef = useRef(null);
  const canvasOcultoRef = useRef(null);
  const canvasOverlayRef = useRef(null);

  // Refs para manejo fluido sin provocar re-renderizados innecesarios
  const procesandoRef = useRef(false);
  const cajaObjetivoRef = useRef(null);
  const cajaSuavizadaRef = useRef(null);
  const datosDeteccionRef = useRef(null);

  const [estadoCamara, setEstadoCamara] = useState("solicitando"); // solicitando | activa | error
  const [camaraPausada, setCamaraPausada] = useState(false);
  const [apiConectada, setApiConectada] = useState(false);
  const [latenciaMs, setLatenciaMs] = useState(0);
  const [resultado, setResultado] = useState({
    rostro_detectado: false,
    con_lentes: false,
    con_mascarilla: false,
    confianza: 0,
  });

  // 1. Solicitar permiso y encender la webcam al abrir la página
  useEffect(() => {
    let stream = null;

    async function iniciarCamara() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
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

  // 2. Bucle de envío de fotogramas hacia Python (~10 FPS para máxima fluidez)
  useEffect(() => {
    if (estadoCamara !== "activa" || camaraPausada) return;

    const intervalo = setInterval(() => {
      enviarFrameAlBackend();
    }, 100);

    return () => clearInterval(intervalo);
  }, [estadoCamara, camaraPausada]);

  const enviarFrameAlBackend = async () => {
    const video = videoRef.current;
    const canvas = canvasOcultoRef.current;
    if (procesandoRef.current || !video || !canvas || video.readyState < 2) return;

    procesandoRef.current = true;
    const inicio = performance.now();

    try {
      // Reducimos a 320px de ancho para que la transferencia sea casi instantánea
      const anchoEnvio = 320;
      const altoEnvio = Math.round((video.videoHeight / video.videoWidth) * anchoEnvio) || 240;
      canvas.width = anchoEnvio;
      canvas.height = altoEnvio;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, anchoEnvio, altoEnvio);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
      const formData = new FormData();
      formData.append("file", blob, "frame.jpg");

      const respuesta = await fetch(API_URL, { method: "POST", body: formData });
      if (!respuesta.ok) throw new Error("Error HTTP");

      const data = await respuesta.json();
      setApiConectada(true);
      setLatenciaMs(Math.round(performance.now() - inicio));
      setResultado(data);
      datosDeteccionRef.current = data;

      if (data.rostro_detectado && data.caja) {
        cajaObjetivoRef.current = data.caja; // Coordenadas normalizadas { x, y, w, h }
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

  // 3. Bucle visual a 60 FPS: interpola la posición del cuadro para evitar saltos al moverse
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

        if (!objetivo || camaraPausada) {
          cajaSuavizadaRef.current = null;
        } else if (!cajaSuavizadaRef.current) {
          cajaSuavizadaRef.current = { ...objetivo };
        } else {
          // Factor 0.3: suaviza el movimiento sin dejar rastro lento
          const f = 0.3;
          cajaSuavizadaRef.current.x += (objetivo.x - cajaSuavizadaRef.current.x) * f;
          cajaSuavizadaRef.current.y += (objetivo.y - cajaSuavizadaRef.current.y) * f;
          cajaSuavizadaRef.current.w += (objetivo.w - cajaSuavizadaRef.current.w) * f;
          cajaSuavizadaRef.current.h += (objetivo.h - cajaSuavizadaRef.current.h) * f;
        }

        if (cajaSuavizadaRef.current && datosDeteccionRef.current) {
          const { x, y, w, h } = cajaSuavizadaRef.current;
          const data = datosDeteccionRef.current;

          // Invertimos X matemáticamente porque el video está en modo espejo (scaleX(-1))
          const drawX = (1 - (x + w)) * overlay.width;
          const drawY = y * overlay.height;
          const drawW = w * overlay.width;
          const drawH = h * overlay.height;

          // Esquinas estilizadas de escáner
          ctx.strokeStyle = "#10b981";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.roundRect(drawX, drawY, drawW, drawH, 10);
          ctx.stroke();

          // Etiqueta superior legible (no invertida)
          const texto = `${data.con_lentes ? "Con Lentes" : "Sin Lentes"} • ${
            data.con_mascarilla ? "Con Mascarilla" : "Sin Mascarilla"
          }`;
          ctx.font = "600 15px system-ui, sans-serif";
          const anchoTexto = ctx.measureText(texto).width + 20;
          const etiquetaY = Math.max(8, drawY - 34);

          ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
          ctx.beginPath();
          ctx.roundRect(drawX, etiquetaY, anchoTexto, 28, 6);
          ctx.fill();

          ctx.fillStyle = "#34d399";
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
    }
  };

  return (
    <div className="layout">
      <header className="topbar">
        <div>
          <h1>Visión Artificial • Detección Facial</h1>
          <p className="subtitulo">Procesamiento en tiempo real con OpenCV & MediaPipe</p>
        </div>
        <div className={`pill-conexion ${apiConectada ? "online" : "offline"}`}>
          <span className="punto"></span>
          {apiConectada ? `API Conectada (${latenciaMs} ms)` : "Esperando Backend Python..."}
        </div>
      </header>

      <main className="contenido-principal">
        {/* Visor de Cámara */}
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

        {/* Panel de Resultados en Vivo */}
        <aside className="panel-resultados">
          <h2>Resultados en Tiempo Real</h2>

          <TarjetaIndicador
            titulo="Estado del Rostro"
            valor={resultado.rostro_detectado ? "Rostro Detectado" : "Buscando rostro..."}
            activo={resultado.rostro_detectado}
          />

          <TarjetaIndicador
            titulo="Detección de Lentes"
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

          <TarjetaIndicador
            titulo="Detección de Mascarilla"
            valor={
              !resultado.rostro_detectado
                ? "Sin lectura"
                : resultado.con_mascarilla
                ? "Con Mascarilla"
                : "Sin Mascarilla"
            }
            activo={resultado.rostro_detectado && resultado.con_mascarilla}
            neutro={!resultado.rostro_detectado}
          />
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