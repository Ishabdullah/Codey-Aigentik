import smtplib
from email.message import EmailMessage
import json
import sys

def send_test_sms(text, name="Maria", phone="8609822868"):
    with open('config.json') as f:
        config = json.load(f)
    
    msg = EmailMessage()
    msg.set_content(text)
    msg['Subject'] = f'New text message from {name} ({phone[:3]}) {phone[3:6]}-{phone[6:]}'
    msg['From'] = config['gmail']['email']  # Spoofing it from itself so we don't need another account
    msg['To'] = config['gmail']['email']

    try:
        server = smtplib.SMTP(config['gmail']['smtp_host'], config['gmail']['smtp_port'])
        server.starttls()
        server.login(config['gmail']['email'], config['gmail']['app_password'])
        server.send_message(msg)
        server.quit()
        print(f"Sent SMS: {text}")
    except Exception as e:
        print(f"Failed to send: {e}")

if __name__ == "__main__":
    send_test_sms(sys.argv[1])
