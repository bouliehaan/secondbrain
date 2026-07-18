#!/bin/bash

# Check if a commit message was provided
if [ -z "$1" ]; then
  echo "Error: No commit message provided."
  echo "Usage: ./commit.sh \"Your commit message here\""
  exit 1
fi

# Add all changes
echo "Adding all files..."
git add .

# Commit with the provided message
echo "Committing: $1"
git commit -m "$1"

# Optionally, you can uncomment the next line to push immediately after committing
# git push origin main
