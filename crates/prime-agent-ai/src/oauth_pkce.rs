use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const VERIFIER_BYTE_LEN: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthPkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn generate_pkce() -> Result<OAuthPkce, getrandom::Error> {
    let mut verifier_bytes = [0u8; VERIFIER_BYTE_LEN];
    getrandom::getrandom(&mut verifier_bytes)?;

    let verifier = base64url_encode(&verifier_bytes);
    let challenge = pkce_challenge_for_verifier(&verifier);

    Ok(OAuthPkce {
        verifier,
        challenge,
    })
}

pub fn pkce_challenge_for_verifier(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64url_encode(&digest)
}

fn base64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_base64url_without_padding(value: &str) -> bool {
        !value.is_empty()
            && !value.contains('=')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }

    #[test]
    fn generated_pkce_uses_base64url_without_padding() {
        let pkce = generate_pkce().unwrap();

        assert_eq!(pkce.verifier.len(), 43);
        assert_eq!(pkce.challenge.len(), 43);
        assert!(is_base64url_without_padding(&pkce.verifier));
        assert!(is_base64url_without_padding(&pkce.challenge));
    }

    #[test]
    fn computes_rfc7636_s256_challenge_for_supplied_verifier() {
        assert_eq!(
            pkce_challenge_for_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
}
