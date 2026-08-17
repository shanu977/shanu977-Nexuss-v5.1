import os
backend = r'C:\Users\pilli\Downloads\Nexuss-git\backend'
for root, dirs, files in os.walk(backend):
    for f in files:
        if f.endswith('.key') or f.endswith('.json'):
            path = os.path.join(root, f)
            print(f'Found: {path}')