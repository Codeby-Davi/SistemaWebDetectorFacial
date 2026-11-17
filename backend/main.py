from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from collections import deque
import cv2
import numpy as np
import os
import urllib.request

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "modelos")
os.makedirs(MODELS_DIR, exist_ok=True)

ARCHIVOS_XML = {
    "face": ("haarcascade_frontalface_default.xml", "https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_frontalface_default.xml"),
    "glasses": ("haarcascade_eye_tree_eyeglasses.xml", "https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_eye_tree_eyeglasses.xml"),
}

rutas_xml = {}
for clave, (nombre, url) in ARCHIVOS_XML.items():
    ruta_local = os.path.join(MODELS_DIR, nombre)
    if not os.path.exists(ruta_local):
        urllib.request.urlretrieve(url, ruta_local)
    rutas_xml[clave] = ruta_local

face_cascade = cv2.CascadeClassifier(rutas_xml["face"])
glasses_cascade = cv2.CascadeClassifier(rutas_xml["glasses"])

historial_lentes = deque(maxlen=4)
historial_mascarilla = deque(maxlen=4)

@app.get("/")
def raiz():
    return {"status": "online", "mensaje": "Backend Modular de Visión Artificial Operativo"}

def detectar_rostro_base(gray_eq, ancho_img, alto_img):
    rostros = face_cascade.detectMultiScale(gray_eq, scaleFactor=1.1, minNeighbors=5, minSize=(50, 50))
    if len(rostros) > 0:
        return max(rostros, key=lambda r: r[2] * r[3]), False

    ojos = glasses_cascade.detectMultiScale(gray_eq, scaleFactor=1.1, minNeighbors=4, minSize=(18, 18))
    if len(ojos) >= 2:
        ojos_ord = sorted(ojos, key=lambda e: e[0])[:2]
        ex1, ey1, ew1, eh1 = ojos_ord[0]
        ex2, ey2, ew2, eh2 = ojos_ord[1]
        if abs(ey1 - ey2) < 25 and (ex2 - ex1) > 15:
            cx = (ex1 + ex2 + ew2) // 2
            cy = (ey1 + ey2) // 2
            aw = int((ex2 + ew2 - ex1) * 1.55)
            ah = int(aw * 1.25)
            rx = max(0, cx - aw // 2)
            ry = max(0, cy - int(ah * 0.35))
            return (rx, ry, min(ancho_img - rx, aw), min(alto_img - ry, ah)), True
    return None, False

def analizar_lentes(frame, gray, x, y, w, h):
    ly1, ly2 = y + int(h * 0.31), y + int(h * 0.53)
    lx1, lx2 = x + int(w * 0.14), x + int(w * 0.86)
    zona_lentes_gray = gray[ly1:ly2, lx1:lx2]
    zona_lentes_bgr = frame[ly1:ly2, lx1:lx2]

    roi_frente_gray = gray[y + int(h * 0.08) : y + int(h * 0.20), x + int(w * 0.30) : x + int(w * 0.70)]
    roi_frente_bgr = frame[y + int(h * 0.08) : y + int(h * 0.20), x + int(w * 0.30) : x + int(w * 0.70)]

    if zona_lentes_gray.size == 0 or roi_frente_gray.size == 0:
        return False, None

    brillo_frente = float(np.mean(roi_frente_gray))
    zh, zw = zona_lentes_gray.shape

    calidez_frente = float(np.mean(roi_frente_bgr[:, :, 2]) - np.mean(roi_frente_bgr[:, :, 0]))
    calidez_lentes = float(np.mean(zona_lentes_bgr[:, :, 2]) - np.mean(zona_lentes_bgr[:, :, 0]))
    reflejo_cristal = calidez_frente - calidez_lentes

    mitad_baja_lentes = zona_lentes_gray[int(zh * 0.45):, :]
    sobel_v = cv2.Sobel(mitad_baja_lentes, cv2.CV_64F, 0, 1, ksize=3)
    borde_aro_inferior = float(np.percentile(np.abs(sobel_v), 88))

    puente = zona_lentes_gray[int(zh * 0.10):int(zh * 0.65), int(zw * 0.40):int(zw * 0.60)]
    caida_puente = brillo_frente - (float(np.percentile(puente, 15)) if puente.size > 0 else brillo_frente)

    detectado = bool(
        reflejo_cristal > 10.5 or
        (caida_puente > 24.0 and borde_aro_inferior > 32.0)
    )
    return detectado, (lx1, ly1, lx2 - lx1, ly2 - ly1)

def analizar_mascarilla_o_mano(frame, gray, x, y, w, h, usando_respaldo):
    # Ventana centrada en los labios (del 62% al 88% del rostro, sin tocar la punta de la nariz)
    my1, my2 = y + int(h * 0.62), y + int(h * 0.88)
    mx1, mx2 = x + int(w * 0.26), x + int(w * 0.74)
    roi_boca_bgr = frame[my1:my2, mx1:mx2]
    roi_boca_gray = gray[my1:my2, mx1:mx2]

    roi_frente_bgr = frame[y + int(h * 0.08) : y + int(h * 0.20), x + int(w * 0.30) : x + int(w * 0.70)]

    if roi_boca_bgr.size == 0 or roi_frente_bgr.size == 0:
        return False, None

    # A) Mascarilla de tela (blanca KN95, celeste quirúrgica u oscura)
    ycrcb_frente = cv2.cvtColor(roi_frente_bgr, cv2.COLOR_BGR2YCrCb)
    cr_frente = np.mean(ycrcb_frente[:, :, 1])
    cb_frente = np.mean(ycrcb_frente[:, :, 2])

    ycrcb_boca = cv2.cvtColor(roi_boca_bgr, cv2.COLOR_BGR2YCrCb)
    diff_cr = np.abs(ycrcb_boca[:, :, 1].astype(np.float32) - cr_frente)
    diff_cb = np.abs(ycrcb_boca[:, :, 2].astype(np.float32) - cb_frente)
    ratio_misma_piel = np.mean((diff_cr < 20) & (diff_cb < 20))
    mascarilla_tela = ratio_misma_piel < 0.38

    # B) Detección de línea de labios descubiertos vs mano tapando:
    # Promediamos horizontalmente cada fila de la zona de la boca para detectar la depresión oscura de los labios.
    # Con boca descubierta existe una caída brusca de brillo en el centro respecto a los bordes superior/inferior (perfil_caida > 22).
    # Cuando la mano tapa, los dedos cruzan horizontalmente de borde a borde con brillo uniforme (perfil_caida < 16).
    perfil_vertical = np.mean(roi_boca_gray, axis=1)
    caida_linea_labios = float(np.max(perfil_vertical) - np.min(perfil_vertical))

    # También medimos el contraste local entre el centro de los labios y las comisuras
    hb, wb = roi_boca_gray.shape
    centro_labios = roi_boca_gray[int(hb * 0.20):int(hb * 0.80), int(wb * 0.20):int(wb * 0.80)]
    sombra_labios = float(np.percentile(centro_labios, 85) - np.percentile(centro_labios, 10))

    mano_tapando = bool(
        usando_respaldo or
        (caida_linea_labios < 17.5 and sombra_labios < 26.0)
    )

    detectado = bool(mascarilla_tela or mano_tapando)
    return detectado, (mx1, my1, mx2 - mx1, my2 - my1)

@app.post("/api/detectar")
async def detectar(file: UploadFile = File(...), modo: str = Form("rostro")):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return {"rostro_detectado": False, "con_lentes": False, "con_mascarilla": False, "confianza": 0, "caja": None, "caja_detalle": None}

    alto_img, ancho_img, _ = frame.shape
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray_eq = cv2.equalizeHist(gray)

    rostro_caja, usando_respaldo = detectar_rostro_base(gray_eq, ancho_img, alto_img)

    if rostro_caja is None:
        historial_lentes.clear()
        historial_mascarilla.clear()
        return {"rostro_detectado": False, "con_lentes": False, "con_mascarilla": False, "confianza": 0, "caja": None, "caja_detalle": None}

    x, y, w, h = rostro_caja

    raw_lentes, rect_lentes = analizar_lentes(frame, gray, x, y, w, h)
    historial_lentes.append(raw_lentes)
    con_lentes = sum(historial_lentes) >= 2

    raw_mascarilla, rect_mascarilla = analizar_mascarilla_o_mano(frame, gray, x, y, w, h, usando_respaldo)
    historial_mascarilla.append(raw_mascarilla)
    con_mascarilla = sum(historial_mascarilla) >= 2

    caja_detalle = None
    if modo == "lentes" and rect_lentes:
        lx, ly, lw, lh = rect_lentes
        caja_detalle = {"x": round(lx / ancho_img, 4), "y": round(ly / alto_img, 4), "w": round(lw / ancho_img, 4), "h": round(lh / alto_img, 4)}
    elif modo == "mascarilla" and rect_mascarilla:
        mx, my, mw, mh = rect_mascarilla
        caja_detalle = {"x": round(mx / ancho_img, 4), "y": round(my / alto_img, 4), "w": round(mw / ancho_img, 4), "h": round(mh / alto_img, 4)}

    caja_normalizada = {
        "x": round(float(x / ancho_img), 4),
        "y": round(float(y / alto_img), 4),
        "w": round(float(w / ancho_img), 4),
        "h": round(float(h / alto_img), 4),
    }

    return {
        "rostro_detectado": True,
        "con_lentes": bool(con_lentes),
        "con_mascarilla": bool(con_mascarilla),
        "confianza": 0.98,
        "caja": caja_normalizada,
        "caja_detalle": caja_detalle
    }