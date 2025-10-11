# Dockerfile para Asistente Legal Flask
FROM python:3.13-slim

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de la app
COPY . /app

# Instalar dependencias
RUN pip install --upgrade pip \
  && pip install --no-cache-dir -r requirements.txt

# Exponer el puerto Flask
EXPOSE 5000

# Variable de entorno para producción
ENV FLASK_ENV=production

# Comando para arrancar con eventlet (soporte WebSocket)
CMD ["python", "app.py"]
