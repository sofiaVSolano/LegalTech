# Asistente Legal de Voz

Asistente legal conversacional con reconocimiento de voz, síntesis de voz y análisis legal usando OpenAI. Permite guardar, visualizar y descargar conversaciones y cartas formales.

## Características
- Interfaz web con preguntas legales guiadas
- Reconocimiento de voz y síntesis (Web Speech API)
- Análisis legal y redacción de carta formal usando OpenAI
- Descarga de resultados en .txt y .docx
- Listado y gestión de conversaciones
- Backend Flask + Socket.IO (WebSocket)
- Docker y Docker Compose listos para despliegue

## Requisitos
- Python 3.13
- Clave de API de OpenAI (variable `OPENAI_API_KEY` en `.env`)
- Docker (opcional para despliegue)

## Instalación local
1. Clona el repositorio:
   ```sh
   git clone <tu-repo>
   cd legal
   ```
2. Crea y activa un entorno virtual:
   ```sh
   python3 -m venv venv
   source venv/bin/activate
   ```
3. Instala dependencias:
   ```sh
   pip install -r requirements.txt
   ```
4. Crea un archivo `.env` con tu clave:
   ```sh
   echo "OPENAI_API_KEY=tu_clave" > .env
   ```
5. Ejecuta la app:
   ```sh
   python app.py
   ```
6. Accede a [http://localhost:5002](http://localhost:5002)

## Uso con Docker
1. Copia tu `.env` (no se sube a GitHub):
   ```sh
   cp .env.example .env
   # Edita y pon tu clave
   ```
2. Construye y ejecuta:
   ```sh
   docker compose up --build
   ```
3. Accede a [http://localhost:5005](http://localhost:5005)

## Variables de entorno
- `OPENAI_API_KEY`: Clave de API de OpenAI
- `SECRET_KEY`: Clave Flask (opcional)
- `GPT_MODEL`: Modelo OpenAI (por defecto: gpt-4-1106-preview)

## Estructura del proyecto
```
legal/
├── app.py
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── .env (no se sube)
├── .gitignore
├── README.md
├── conversaciones/
├── static/
│   ├── css/
│   └── js/
├── templates/
```

## Seguridad
- No subas tu `.env` ni claves privadas.
- `.gitignore` ya protege archivos sensibles.

## Créditos
Desarrollado por [tu nombre].

---
GitHub Copilot
