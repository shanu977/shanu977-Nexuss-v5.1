import sqlite3
conn = sqlite3.connect('test_chatbot.db')
cursor = conn.cursor()
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cursor.fetchall()
print('Tables:', tables)
for t in tables:
    cursor.execute(f'PRAGMA table_info({t[0]})')
    print(f'{t[0]} columns:', cursor.fetchall())
conn.close()