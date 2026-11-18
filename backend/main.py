from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from collections import deque
import cv2
import mediapipe as mp
import numpy as np

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Modelo de malla facial (468 puntos + iris refinados)
mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(
    static_image_mode=False,
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=0.65,
    min_tracking_confidence=0.65,
)

# 2. Modelo de detección de manos (para detectar cuando te tapas la boca con la mano)
mp_hands = mp.solutions.hands
hands_detector = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    model_complexity=0,  # Rápido en CPU (~5 ms)
    min_detection_confidence=0.55,
    min_tracking_confidence=0.55,
)

# Parámetros de histéresis para lentes (puedes ajustar estos 2 valores si cambias de iluminación)
UMBRAL_LENTES_ON = 0.48   # Puntaje para activar "Con Lentes"
UMBRAL_LENTES_OFF = 0.34  # Puntaje mínimo para mantenerlo activo sin parpadear

estado_lentes_bloqueado = False
historial_lentes = deque(maxlen=5)
historial_mascarilla = deque(maxlen=5)


@app.get("/")
def raiz():
    return {"status": "online", "mensaje": "Backend MediaPipe FaceMesh + Hands Operativo"}


def recorte_seguro(img, x1, y1, x2, y2):
    h, w = img.shape[:2]
    x1, y1 = max(0, int(x1)), max(0, int(y1))
    x2, y2 = min(w, int(x2)), min(h, int(y2))
    if x2 <= x1 or y2 <= y1:
        return None
    return img[y1:y2, x1:x2]


def fuerza_borde_horizontal(parche_gray):
    """Mide bordes horizontales (puente, marcos superior/inferior, patillas) filtrando sombras verticales."""
    if parche_gray is None or parche_gray.size < 12:
        return 0.0
    sobel_y = np.abs(cv2.Sobel(parche_gray, cv2.CV_64F, 0, 1, ksize=3))
    sobel_x = np.abs(cv2.Sobel(parche_gray, cv2.CV_64F, 1, 0, ksize=3))
    # Restamos gradiente horizontal (sobel_x) para ignorar sombras laterales de ventanas
    neto = np.percentile(sobel_y, 85) - 0.50 * np.percentile(sobel_x, 85)
    return float(max(0.0, neto))


def analizar_lentes_estable(gray, landmarks, ancho_img, alto_img, ancho_rostro):
    """Calcula un puntaje continuo (0.0 a 1.0) sobre 4 partes anatómicas de los lentes."""
    global estado_lentes_bloqueado

    # Centros reales de ambos ojos (párpado superior 159/386 e inferior 145/374)
    ojo_izq_x = ((landmarks[33].x + landmarks[133].x) / 2.0) * ancho_img
    ojo_izq_y = ((landmarks[159].y + landmarks[145].y) / 2.0) * alto_img
    ojo_der_x = ((landmarks[362].x + landmarks[263].x) / 2.0) * ancho_img
    ojo_der_y = ((landmarks[386].y + landmarks[374].y) / 2.0) * alto_img
    centro_ojos_y = (ojo_izq_y + ojo_der_y) / 2.0

    # A) Puente nasal: franja exacta entre los lagrimales (133 y 362)
    puente_x1 = landmarks[133].x * ancho_img
    puente_x2 = landmarks[362].x * ancho_img
    puente = recorte_seguro(
        gray,
        min(puente_x1, puente_x2),
        centro_ojos_y - ancho_rostro * 0.055,
        max(puente_x1, puente_x2),
        centro_ojos_y + ancho_rostro * 0.045,
    )
    score_puente = min(1.0, fuerza_borde_horizontal(puente) / 34.0)

    # B) Borde superior de la montura (entre párpado superior y ceja)
    rx = ancho_rostro * 0.11
    ry = ancho_rostro * 0.035
    sup_izq = recorte_seguro(gray, ojo_izq_x - rx, ojo_izq_y - ancho_rostro * 0.075 - ry, ojo_izq_x + rx, ojo_izq_y - ancho_rostro * 0.075 + ry)
    sup_der = recorte_seguro(gray, ojo_der_x - rx, ojo_der_y - ancho_rostro * 0.075 - ry, ojo_der_x + rx, ojo_der_y - ancho_rostro * 0.075 + ry)
    score_superior = min(1.0, ((fuerza_borde_horizontal(sup_izq) + fuerza_borde_horizontal(sup_der)) / 2.0) / 38.0)

    # C) Aro inferior de la montura (debajo del párpado inferior)
    inf_izq = recorte_seguro(gray, ojo_izq_x - rx, ojo_izq_y + ancho_rostro * 0.075 - ry, ojo_izq_x + rx, ojo_izq_y + ancho_rostro * 0.075 + ry)
    inf_der = recorte_seguro(gray, ojo_der_x - rx, ojo_der_y + ancho_rostro * 0.075 - ry, ojo_der_x + rx, ojo_der_y + ancho_rostro * 0.075 + ry)
    score_inferior = min(1.0, ((fuerza_borde_horizontal(inf_izq) + fuerza_borde_horizontal(inf_der)) / 2.0) / 30.0)

    # D) Patillas en las sienes (entre esquina externa del ojo y borde lateral del rostro)
    sien_izq_x = ((landmarks[33].x + landmarks[127].x) / 2.0) * ancho_img
    sien_der_x = ((landmarks[263].x + landmarks[356].x) / 2.0) * ancho_img
    pat_izq = recorte_seguro(gray, sien_izq_x - ancho_rostro * 0.05, ojo_izq_y - ancho_rostro * 0.05, sien_izq_x + ancho_rostro * 0.05, ojo_izq_y + ancho_rostro * 0.05)
    pat_der = recorte_seguro(gray, sien_der_x - ancho_rostro * 0.05, ojo_der_y - ancho_rostro * 0.05, sien_der_x + ancho_rostro * 0.05, ojo_der_y + ancho_rostro * 0.05)
    score_patillas = min(1.0, max(fuerza_borde_horizontal(pat_izq), fuerza_borde_horizontal(pat_der)) / 36.0)

    # Puntaje ponderado total
    puntaje_total = (
        0.35 * score_puente +
        0.25 * score_superior +
        0.25 * score_inferior +
        0.15 * score_patillas
    )

    # Histéresis para evitar que parpadee al inclinar ligeramente la cabeza
    if estado_lentes_bloqueado:
        if puntaje_total < UMBRAL_LENTES_OFF:
            estado_lentes_bloqueado = False
    else:
        if puntaje_total >= UMBRAL_LENTES_ON:
            estado_lentes_bloqueado = True

    # Recuadro visual centrado exactamente en los ojos y lunas
    x1 = int(min(landmarks[127].x, landmarks[356].x) * ancho_img)
    x2 = int(max(landmarks[127].x, landmarks[356].x) * ancho_img)
    y1 = int(centro_ojos_y - ancho_rostro * 0.13)
    y2 = int(centro_ojos_y + ancho_rostro * 0.13)
    rect_lentes = (max(0, x1), max(0, y1), max(1, x2 - x1), max(1, y2 - y1))

    return estado_lentes_bloqueado, rect_lentes


def analizar_mascarilla_y_mano(frame, landmarks, resultados_manos, ancho_img, alto_img, ancho_rostro):
    """Combina detección de color (mascarilla/objeto) + detección real de mano con MediaPipe Hands."""
    # Referencia de piel limpia en la frente (punto 10)
    fx, fy = landmarks[10].x * ancho_img, landmarks[10].y * alto_img
    r_frente = ancho_rostro * 0.08
    frente_bgr = recorte_seguro(frame, fx - r_frente, fy - r_frente, fx + r_frente, fy + r_frente)

    # Zona inferior del rostro (desde tabique medio 195 hasta debajo del mentón 152)
    mx1 = int(min(landmarks[205].x, landmarks[425].x) * ancho_img)
    mx2 = int(max(landmarks[205].x, landmarks[425].x) * ancho_img)
    my1 = int(landmarks[195].y * alto_img)
    my2 = int(min(alto_img, landmarks[152].y * alto_img + ancho_rostro * 0.05))
    zona_mascarilla_bgr = recorte_seguro(frame, mx1, my1, mx2, my2)

    if frente_bgr is None or zona_mascarilla_bgr is None:
        return False, None

    # 1. Prueba de Mascarilla / Objeto (celular, tela, KN95): compara tono de piel en espacio YCrCb
    ycrcb_frente = cv2.cvtColor(frente_bgr, cv2.COLOR_BGR2YCrCb)
    cr_frente = float(np.mean(ycrcb_frente[:, :, 1]))
    cb_frente = float(np.mean(ycrcb_frente[:, :, 2]))

    ycrcb_masc = cv2.cvtColor(zona_mascarilla_bgr, cv2.COLOR_BGR2YCrCb)
    diff_cr = np.abs(ycrcb_masc[:, :, 1].astype(np.float32) - cr_frente)
    diff_cb = np.abs(ycrcb_masc[:, :, 2].astype(np.float32) - cb_frente)
    ratio_piel_inferior = float(np.mean((diff_cr < 22) & (diff_cb < 22)))

    tiene_mascarilla_u_objeto = ratio_piel_inferior < 0.48

    # 2. Prueba directa de Mano cubriendo la boca usando MediaPipe Hands
    mano_sobre_boca = False
    if resultados_manos.multi_hand_landmarks:
        # Área de impacto alrededor de nariz y boca con margen de seguridad
        zona_x1 = (min(landmarks[234].x, landmarks[454].x) * ancho_img) - ancho_rostro * 0.08
        zona_x2 = (max(landmarks[234].x, landmarks[454].x) * ancho_img) + ancho_rostro * 0.08
        zona_y1 = landmarks[6].y * alto_img  # Desde el puente nasal hacia abajo
        zona_y2 = (landmarks[152].y * alto_img) + ancho_rostro * 0.15

        for mano in resultados_manos.multi_hand_landmarks:
            puntos_dentro = 0
            for lm in mano.landmark:
                hx = lm.x * ancho_img
                hy = lm.y * alto_img
                if zona_x1 <= hx <= zona_x2 and zona_y1 <= hy <= zona_y2:
                    puntos_dentro += 1
            # Si al menos 2 articulaciones de la mano están frente a la boca/nariz
            if puntos_dentro >= 2:
                mano_sobre_boca = True
                break

    detectado = bool(tiene_mascarilla_u_objeto or mano_sobre_boca)
    rect_mascarilla = (max(0, mx1), max(0, my1), max(1, mx2 - mx1), max(1, my2 - my1))
    return detectado, rect_mascarilla


@app.post("/api/detectar")
async def detectar(file: UploadFile = File(...), modo: str = Form("rostro")):
    global estado_lentes_bloqueado

    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        return {
            "rostro_detectado": False,
            "con_lentes": False,
            "con_mascarilla": False,
            "confianza": 0,
            "caja": None,
            "caja_detalle": None,
        }

    alto_img, ancho_img, _ = frame.shape
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    resultados_rostro = face_mesh.process(rgb)

    if not resultados_rostro.multi_face_landmarks:
        historial_lentes.clear()
        historial_mascarilla.clear()
        estado_lentes_bloqueado = False
        return {
            "rostro_detectado": False,
            "con_lentes": False,
            "con_mascarilla": False,
            "confianza": 0,
            "caja": None,
            "caja_detalle": None,
        }

    # Solo ejecutamos detección de manos cuando hay rostro (y especialmente útil en modo mascarilla/rostro)
    resultados_manos = hands_detector.process(rgb)

    landmarks = resultados_rostro.multi_face_landmarks[0].landmark

    xs = [lm.x for lm in landmarks]
    ys = [lm.y for lm in landmarks]
    min_x, max_x = max(0.0, min(xs)), min(1.0, max(xs))
    min_y, max_y = max(0.0, min(ys)), min(1.0, max(ys))

    ancho_rostro = max(20.0, abs(landmarks[454].x - landmarks[234].x) * ancho_img)

    raw_lentes, rect_lentes = analizar_lentes_estable(gray, landmarks, ancho_img, alto_img, ancho_rostro)
    historial_lentes.append(raw_lentes)
    con_lentes = sum(historial_lentes) >= 3

    raw_mascarilla, rect_mascarilla = analizar_mascarilla_y_mano(
        frame, landmarks, resultados_manos, ancho_img, alto_img, ancho_rostro
    )
    historial_mascarilla.append(raw_mascarilla)
    con_mascarilla = sum(historial_mascarilla) >= 2

    caja_detalle = None
    if modo == "lentes" and rect_lentes:
        lx, ly, lw, lh = rect_lentes
        caja_detalle = {
            "x": round(lx / ancho_img, 4),
            "y": round(ly / alto_img, 4),
            "w": round(lw / ancho_img, 4),
            "h": round(lh / alto_img, 4),
        }
    elif modo == "mascarilla" and rect_mascarilla:
        mx, my, mw, mh = rect_mascarilla
        caja_detalle = {
            "x": round(mx / ancho_img, 4),
            "y": round(my / alto_img, 4),
            "w": round(mw / ancho_img, 4),
            "h": round(mh / alto_img, 4),
        }

    caja_normalizada = {
        "x": round(float(min_x), 4),
        "y": round(float(min_y), 4),
        "w": round(float(max_x - min_x), 4),
        "h": round(float(max_y - min_y), 4),
    }

    return {
        "rostro_detectado": True,
        "con_lentes": bool(con_lentes),
        "con_mascarilla": bool(con_mascarilla),
        "confianza": 0.99,
        "caja": caja_normalizada,
        "caja_detalle": caja_detalle,
    }