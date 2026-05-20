#!/bin/bash
set -e

cd /opt/apps/react-dashboard

echo "Fetching latest code..."
git fetch origin
git checkout development
git pull origin development

echo "Building and restarting containers..."
docker compose up -d --build

echo "Cleaning Docker build cache..."
docker builder prune -af

echo "Deployment completed."
