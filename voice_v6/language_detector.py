"""Script + Roman-Hindi detection per word/span."""
from __future__ import annotations
import re

DEVA = re.compile(r"[\u0900-\u097F]")
# common Roman Hindi function words / verbs (high precision; English collisions like 'is', 'me' avoided)
ROMAN_HI = set("""ka ki ke ko se mein main hai hain ho hota hoti hote tha thi the kya kyun kyu kaise kaisa kab kahan
kaun kitna kitne yeh ye woh wo aur ya lekin par pe nahi nahin mat bhi hi toh to abhi bahut bohot thoda zyada
matlab samajh samjho batao bata bol bolo kar karo karna kare kiya krna dena do de diya lo lena chahiye chahta
mera meri mere tera teri tere apna apni uska uski unka hum tum aap isko usko isme usme isse usse sab sabhi
ek do teen char paanch hota hoga hogi honge raha rahi rahe rha rhi liye wala wali wale jaise jab tab agar
isliye kyunki kyonki sakta sakti sakte skta pata chal chalo dekho dekh aao jao ja aana jana accha achha theek
sahi galat ab fir phir kuch koi kisi kaam naya nayi pehle baad sirf bas yahan wahan""".split())
_WORD = re.compile(r"[A-Za-z\u0900-\u097F][A-Za-z\u0900-\u097F']*")


def word_lang(w: str) -> str:
    if DEVA.search(w):
        return "hi"
    return "hi" if w.lower() in ROMAN_HI else "en"


def detect(text: str) -> str:
    """'hi' | 'en' | 'hinglish' for a whole text."""
    ws = _WORD.findall(text)
    if not ws:
        return "en"
    hi = sum(word_lang(w) == "hi" for w in ws)
    if hi == 0:
        return "en"
    return "hi" if hi == len(ws) else "hinglish"
